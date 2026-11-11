// The pipeline: brief -> Claude writes content -> review (dashboard or Slack) -> approved / changes / rejected.
// Work runs as jobs in a MySQL table. A job starts in-process the moment it is created; the
// every-minute cron call picks up anything interrupted by a restart or waiting on a retry.
import { MAX_VERSIONS, PLATFORMS, now, parseJson } from './util.js';
import { generateContent, DEFAULT_MODEL } from './services/claude.js';

const MAX_ATTEMPTS = 3;
const STALE_MS = 5 * 60 * 1000;

export class ReviewError extends Error {}

export function createEngine({ db, settings, slack, config, fetchImpl = fetch, log = console, autoKick = true }) {
  let draining = false;

  const hydrate = (row) => row && {
    ...row,
    brief: parseJson(row.brief, {}),
    content: parseJson(row.content, null),
    platforms: String(row.platforms || '').split(',').filter((p) => PLATFORMS[p]),
  };

  async function getPost(id) {
    return hydrate(await db.get('SELECT * FROM posts WHERE id = ?', [Number(id)]));
  }

  async function addEvent(postId, kind, actor, note = '') {
    await db.run('INSERT INTO post_events (post_id, kind, actor, note, created_at) VALUES (?, ?, ?, ?, ?)',
      [postId, kind, actor, note, now()]);
  }

  async function enqueue(kind, postId, payload = {}, delayMs = 0) {
    await db.run(
      `INSERT INTO jobs (kind, post_id, payload, status, attempts, run_at, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
      [kind, postId, JSON.stringify(payload), now(delayMs), now(), now()]);
  }

  /** Start work right away without making the web request wait for it. */
  function kick() {
    if (!autoKick) return;
    setImmediate(() => drain().catch((err) => log.error('queue error', err)));
  }

  async function createPost({ workspaceId, actor, brief, platforms, publishAt }) {
    const t = now();
    const { insertId } = await db.run(
      `INSERT INTO posts (workspace_id, created_by, status, version, brief, platforms, publish_at, created_at, updated_at)
       VALUES (?, ?, 'generating', 0, ?, ?, ?, ?, ?)`,
      [workspaceId, actor, JSON.stringify(brief), platforms.join(','), publishAt || null, t, t]);
    await addEvent(insertId, 'created', actor);
    await enqueue('generate', insertId);
    return insertId;
  }

  // ---- Job handlers ----

  async function runGenerate(job) {
    const post = await getPost(job.post_id);
    if (!post || post.status !== 'generating') return; // decided or removed meanwhile
    const ws = await db.get('SELECT * FROM workspaces WHERE id = ?', [post.workspace_id]);
    const payload = parseJson(job.payload, {});
    const model = (await settings.get('claude_model')) || DEFAULT_MODEL;
    const result = await generateContent({
      apiKey: await settings.get('anthropic_api_key'), model, workspace: ws,
      brief: post.brief, platforms: post.platforms,
      previous: payload.note ? post.content : null, note: payload.note || null, fetchImpl,
    });
    const version = post.version + 1;
    const updated = await db.run(
      `UPDATE posts SET status = 'in_review', version = ?, content = ?, error = NULL, slack_ts = NULL, slack_channel = NULL, updated_at = ?
       WHERE id = ? AND status = 'generating'`,
      [version, JSON.stringify(result.content), now(), post.id]);
    if (!updated.changes) return;
    await db.run(
      `INSERT INTO usage_log (workspace_id, post_id, kind, model, input_tokens, output_tokens, created_at) VALUES (?, ?, 'content', ?, ?, ?, ?)`,
      [post.workspace_id, post.id, result.model, result.usage.input, result.usage.output, now()]);
    await addEvent(post.id, 'generated', 'Claude', `Version ${version}`);
    await notifySlack(await getPost(post.id), ws);
  }

  /** Send the review message to Slack. A Slack problem never blocks the post: it stays reviewable in the dashboard. */
  async function notifySlack(post, ws) {
    const token = await settings.get('slack_bot_token');
    if (!token || !ws.slack_channel) return;
    try {
      const sent = await slack.postReview(token, ws.slack_channel, post, ws, config.appUrl);
      await db.run('UPDATE posts SET slack_channel = ?, slack_ts = ? WHERE id = ?', [sent.channel, sent.ts, post.id]);
      await addEvent(post.id, 'slack_sent', 'System');
    } catch (err) {
      await addEvent(post.id, 'slack_failed', 'System', err.message);
    }
  }

  async function updateSlack(post, line) {
    if (!post.slack_ts || !post.slack_channel) return;
    const token = await settings.get('slack_bot_token');
    if (!token) return;
    const ws = await db.get('SELECT * FROM workspaces WHERE id = ?', [post.workspace_id]);
    try { await slack.markDecided(token, post, ws, config.appUrl, line); } catch (err) { log.error('slack update failed', err.message); }
  }

  const handlers = { generate: runGenerate };

  // ---- Queue ----

  async function claimNext() {
    // Jobs left "running" by a restart become available again after 5 minutes.
    await db.run(`UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running' AND locked_at < ?`, [now(), now(-STALE_MS)]);
    const candidates = await db.all(`SELECT * FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY id LIMIT 5`, [now()]);
    for (const job of candidates) {
      const claimed = await db.run(
        `UPDATE jobs SET status = 'running', locked_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'`,
        [now(), now(), job.id]);
      if (claimed.changes) return { ...job, attempts: job.attempts + 1 };
    }
    return null;
  }

  async function runJob(job) {
    try {
      if (!handlers[job.kind]) throw Object.assign(new Error(`Unknown job kind: ${job.kind}`), { permanent: true });
      await handlers[job.kind](job);
      await db.run(`UPDATE jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?`, [now(), job.id]);
    } catch (err) {
      const giveUp = err.permanent || job.attempts >= MAX_ATTEMPTS;
      await db.run(`UPDATE jobs SET status = ?, error = ?, run_at = ?, updated_at = ? WHERE id = ?`,
        [giveUp ? 'failed' : 'queued', err.message, now(job.attempts * 60_000), now(), job.id]);
      if (giveUp && job.post_id) {
        const failed = await db.run(`UPDATE posts SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'generating'`,
          [err.message, now(), job.post_id]);
        if (failed.changes) await addEvent(job.post_id, 'failed', 'System', err.message);
      }
      log.error(`job ${job.id} (${job.kind}) failed:`, err.message);
    }
  }

  /** Run due jobs until none are left (or the limit is hit). Returns how many ran. */
  async function drain(limit = 20) {
    if (draining) return 0;
    draining = true;
    let ran = 0;
    try {
      for (; ran < limit; ran++) {
        const job = await claimNext();
        if (!job) break;
        await runJob(job);
      }
    } finally { draining = false; }
    return ran;
  }

  // ---- Review decisions (shared by the dashboard and Slack) ----

  async function decide(postId, status, actor) {
    const done = await db.run(
      `UPDATE posts SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'in_review'`,
      [status, actor, now(), now(), Number(postId)]);
    if (!done.changes) throw new ReviewError('This post is no longer waiting for review.');
    return getPost(postId);
  }

  async function approve(postId, actor) {
    const post = await decide(postId, 'approved', actor);
    await addEvent(post.id, 'approved', actor);
    await updateSlack(post, `Approved by ${actor}`);
    return post;
  }

  async function reject(postId, actor, note = '') {
    const post = await decide(postId, 'rejected', actor);
    await addEvent(post.id, 'rejected', actor, note);
    await updateSlack(post, `Rejected by ${actor}${note ? `: ${note}` : ''}`);
    return post;
  }

  async function requestChanges(postId, actor, note) {
    note = String(note || '').trim();
    if (!note) throw new ReviewError('Say what should change.');
    const current = await getPost(postId);
    if (!current) throw new ReviewError('Post not found.');
    if (current.status === 'in_review' && current.version >= MAX_VERSIONS) {
      throw new ReviewError(`This post already had ${MAX_VERSIONS - 1} rounds of changes. Approve it, reject it, or start a new brief.`);
    }
    const post = await decide(postId, 'generating', actor);
    await addEvent(post.id, 'changes_requested', actor, note);
    await updateSlack(post, `Changes requested by ${actor}: ${note}`);
    await enqueue('generate', post.id, { note });
    kick();
    return post;
  }

  /** Try a failed post again. */
  async function retry(postId, actor) {
    const post = await getPost(postId);
    const done = await db.run(`UPDATE posts SET status = 'generating', error = NULL, updated_at = ? WHERE id = ? AND status = 'failed'`, [now(), Number(postId)]);
    if (!done.changes) throw new ReviewError('Only failed posts can be retried.');
    await addEvent(post.id, 'retried', actor);
    // A failed revision keeps its reviewer note so the retry applies the same changes.
    const last = await db.get(`SELECT payload FROM jobs WHERE post_id = ? ORDER BY id DESC LIMIT 1`, [post.id]);
    await enqueue('generate', post.id, parseJson(last?.payload, {}));
    kick();
  }

  return { getPost, createPost, approve, reject, requestChanges, retry, drain, kick, addEvent };
}
