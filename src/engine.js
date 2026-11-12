// The pipeline: brief -> Claude writes content -> review (dashboard or Slack) -> approved -> published.
// Work runs as jobs in a MySQL table. A job starts in-process the moment it is created; the
// every-minute cron call picks up anything interrupted by a restart, waiting on a retry, or scheduled.
import { MAX_VERSIONS, PLATFORMS, PUBLISHABLE, now, parseJson, formatTime } from './util.js';
import { generateContent, DEFAULT_MODEL } from './services/claude.js';
import { createMeta } from './services/meta.js';
import { generateImage, imagePrompt, DEFAULT_IMAGE_MODEL } from './services/gemini.js';
import { createCanva, autofillData } from './services/canva.js';
import { encrypt } from './security.js';
import { createMedia, instagramProblem } from './media.js';
import { decrypt } from './security.js';

const MAX_ATTEMPTS = 3;
const STALE_MS = 5 * 60 * 1000;

export class ReviewError extends Error {}

/** Caption text sent to a platform: the caption plus hashtags. */
export function captionFor(post, platform) {
  const c = post.content || {};
  const tags = (c.hashtags || []).map((h) => `#${h}`).join(' ');
  return [c.captions?.[platform] || '', tags].filter(Boolean).join('\n\n');
}

export function createEngine({ db, settings, slack, config, fetchImpl = fetch, log = console, autoKick = true, meta, canva }) {
  let draining = false;
  const media = createMedia(db, config.appUrl);
  meta = meta || createMeta({ fetchImpl });
  canva = canva || createCanva({ fetchImpl });

  const hydrate = (row) => row && {
    ...row,
    brief: parseJson(row.brief, {}),
    content: parseJson(row.content, null),
    platforms: String(row.platforms || '').split(',').filter((p) => PLATFORMS[p]),
  };

  async function getPost(id) {
    const post = hydrate(await db.get('SELECT * FROM posts WHERE id = ?', [Number(id)]));
    if (post) {
      post.image = await media.forPost(post);
      post.photo = post.photo_id ? await media.byId(post.photo_id) : null;
    }
    return post;
  }

  const getBrand = (id) => db.get('SELECT * FROM workspaces WHERE id = ?', [id]);

  async function addEvent(postId, kind, actor, note = '') {
    await db.run('INSERT INTO post_events (post_id, kind, actor, note, created_at) VALUES (?, ?, ?, ?, ?)',
      [postId, kind, actor, note, now()]);
  }

  async function enqueue(kind, postId, payload = {}, delayMs = 0, runAt = null) {
    await db.run(
      `INSERT INTO jobs (kind, post_id, payload, status, attempts, run_at, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
      [kind, postId, JSON.stringify(payload), runAt || now(delayMs), now(), now()]);
  }

  /** Start work right away without making the web request wait for it. */
  function kick() {
    if (!autoKick) return;
    setImmediate(() => drain().catch((err) => log.error('queue error', err)));
  }

  async function createPost({ workspaceId, actor, brief, platforms, publishAt, sourceRef = null }) {
    const t = now();
    const { insertId } = await db.run(
      `INSERT INTO posts (workspace_id, created_by, status, version, brief, platforms, publish_at, source_ref, created_at, updated_at)
       VALUES (?, ?, 'generating', 0, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, actor, JSON.stringify(brief), platforms.join(','), publishAt || null, sourceRef, t, t]);
    await addEvent(insertId, 'created', actor);
    await enqueue('generate', insertId);
    return insertId;
  }

  // ---- Slack ----

  async function slackToken() { return settings.get('slack_bot_token'); }

  /** Send the review message to Slack. A Slack problem never blocks the post: it stays reviewable in the dashboard. */
  async function notifySlack(post, ws) {
    const token = await slackToken();
    if (!token || !ws.slack_channel) return;
    try {
      const sent = await slack.postReview(token, ws.slack_channel, post, ws, config.appUrl);
      await db.run('UPDATE posts SET slack_channel = ?, slack_ts = ? WHERE id = ?', [sent.channel, sent.ts, post.id]);
      await addEvent(post.id, 'slack_sent', 'System');
      await requestThread(post, `Version ${post.version} is ready. Review it in <#${ws.slack_channel}>.`);
    } catch (err) {
      await addEvent(post.id, 'slack_failed', 'System', err.message);
    }
  }

  async function updateSlack(post, line) {
    if (!post.slack_ts || !post.slack_channel) return;
    const token = await slackToken();
    if (!token) return;
    const ws = await getBrand(post.workspace_id);
    try { await slack.markDecided(token, post, ws, config.appUrl, line); } catch (err) { log.error('slack update failed', err.message); }
  }

  /** Refresh the review message (e.g. after an image is added) while it still has its buttons. */
  async function refreshSlackReview(post) {
    if (post.status !== 'in_review' || !post.slack_ts) return;
    const token = await slackToken();
    if (!token) return;
    const ws = await getBrand(post.workspace_id);
    try { await slack.updateReview(token, post, ws, config.appUrl); } catch (err) { log.error('slack refresh failed', err.message); }
  }

  /** Reply under the Slack message that asked for this post, if it came from Slack. */
  async function requestThread(post, text) {
    const m = /^slack:([A-Z0-9]+):([\d.]+)$/.exec(post.source_ref || '');
    if (!m) return;
    const token = await slackToken();
    if (!token) return;
    try { await slack.postThread(token, m[1], m[2], text); } catch (err) { log.error('slack request reply failed', err.message); }
  }

  async function slackThread(post, text) {
    if (!post.slack_ts || !post.slack_channel) return;
    const token = await slackToken();
    if (!token) return;
    try { await slack.postThread(token, post.slack_channel, post.slack_ts, text); } catch (err) { log.error('slack thread failed', err.message); }
  }

  // ---- Images from Gemini ----

  /**
   * Make (or edit) the post's image with Gemini. Never throws: a failure is recorded on the post
   * and the post carries on without a new image.
   */
  async function renderWithGemini(post, ws, content, { editNote = '', previousId = null, photoOnly = false, aspectRatio = '4:5' } = {}) {
    const apiKey = await settings.get('gemini_api_key');
    if (!apiKey) return null;
    const references = [];
    const previous = editNote && previousId ? await media.bytes(previousId) : null;
    if (previous) references.push(previous);
    const logo = !previous && !photoOnly && ws.logo_id ? await media.bytes(ws.logo_id) : null;
    if (logo) references.push(logo);
    const model = (await settings.get('gemini_model')) || DEFAULT_IMAGE_MODEL;
    const args = {
      apiKey, model, references, fetchImpl, aspectRatio,
      imageSize: (await settings.get('gemini_image_size')) || '1K',
      prompt: imagePrompt({ brand: ws, content, hasLogo: !!logo, editNote: previous ? editNote : '', photoOnly }),
    };
    for (let attempt = 1; ; attempt++) {
      try {
        const buf = await generateImage(args);
        await db.run(
          `INSERT INTO usage_log (workspace_id, post_id, kind, model, input_tokens, output_tokens, created_at) VALUES (?, ?, 'image', ?, 0, 0, ?)`,
          [post.workspace_id, post.id, model, now()]);
        return { buf, edited: !!previous };
      } catch (err) {
        if (err.permanent || attempt >= 2) { await addEvent(post.id, 'image_failed', 'Gemini', err.message); return null; }
      }
    }
  }

  /** Finished image straight from Gemini (headline and logo drawn by Gemini). Used when the brand has no Canva template. */
  async function makeImage(post, ws, content, opts = {}) {
    const out = await renderWithGemini(post, ws, content, opts);
    if (!out) return false;
    try {
      const saved = await media.saveAny(post.id, out.buf, 'gemini');
      await db.run('UPDATE posts SET image_id = ?, updated_at = ? WHERE id = ?', [saved.id, now(), post.id]);
      if (post.image_id) await db.run('DELETE FROM media WHERE id = ?', [post.image_id]);
      await addEvent(post.id, out.edited ? 'image_edited' : 'image_generated', 'Gemini', `${saved.width}×${saved.height}`);
      return true;
    } catch (err) {
      await addEvent(post.id, 'image_failed', 'Gemini', err.message);
      return false;
    }
  }

  // ---- Canva template ----

  /** The brand's Canva connection, if it is connected and a template is chosen. */
  async function canvaConnection(workspaceId) {
    const row = await db.get(`SELECT * FROM connections WHERE workspace_id = ? AND platform = 'canva'`, [workspaceId]);
    if (!row || !row.extra_id) return null;
    return { ...row, map: parseJson(row.data, {}) };
  }

  /** A valid Canva access token for a connection row, refreshing (and storing the new refresh token) when needed. */
  async function canvaToken(row) {
    let tokens = parseJson(decrypt(row.token, config.secretKey), {});
    if (!tokens.access || tokens.expiresAt - 5 * 60_000 < Date.now()) {
      tokens = await canva.refresh({
        clientId: await settings.get('canva_client_id'), clientSecret: await settings.get('canva_client_secret'),
        refreshToken: tokens.refresh,
      });
      await db.run('UPDATE connections SET token = ?, updated_at = ? WHERE id = ?', [encrypt(JSON.stringify(tokens), config.secretKey), now(), row.id]);
    }
    return tokens.access;
  }

  /** Photo only (no text or logo) for the Canva template. Returns the media id, or null. */
  async function makePhoto(post, ws, content, conn, { editNote = '' } = {}) {
    const out = await renderWithGemini(post, ws, content, {
      editNote, previousId: post.photo_id, photoOnly: true, aspectRatio: conn.map.shape || '1:1',
    });
    if (!out) return null;
    const saved = await media.saveAny(post.id, out.buf, 'photo');
    await db.run('UPDATE posts SET photo_id = ?, updated_at = ? WHERE id = ?', [saved.id, now(), post.id]);
    if (post.photo_id) await db.run('DELETE FROM media WHERE id = ?', [post.photo_id]);
    await addEvent(post.id, out.edited ? 'photo_edited' : 'photo_generated', 'Gemini', `${saved.width}×${saved.height}`);
    return saved.id;
  }

  /** Put the photo and text into the Canva template, export the design and make it the post's image. */
  async function composeCanva(post, ws, content, conn, photoId) {
    try {
      const token = await canvaToken(conn);
      const photo = await media.byId(photoId);
      const assetId = photo ? await canva.uploadFromUrl(token, `${ws.name} post ${post.id}`, photo.url) : null;
      const design = await canva.autofill(token, {
        templateId: conn.extra_id, title: `${ws.name} – ${content.headline}`,
        data: autofillData(conn.map.fields, { assetId, content, brandName: ws.name }),
      });
      const saved = await media.saveAny(post.id, await canva.exportJpg(token, design.id), 'canva');
      await db.run('UPDATE posts SET image_id = ?, canva_design_id = ?, canva_edit_url = ?, updated_at = ? WHERE id = ?',
        [saved.id, design.id, design.editUrl.slice(0, 600), now(), post.id]);
      if (post.image_id) await db.run('DELETE FROM media WHERE id = ?', [post.image_id]);
      await addEvent(post.id, 'canva_composed', 'Canva', `${conn.extra_name} · ${saved.width}×${saved.height}`);
      return true;
    } catch (err) {
      await addEvent(post.id, 'canva_failed', 'Canva', err.message);
      return false;
    }
  }

  /**
   * Make or update the post's creative. With a Canva template: Gemini photo -> template -> export.
   * Without one: a finished image from Gemini. `editNote` changes the picture; `textChanged` only re-fills the text.
   */
  async function makeCreative(post, ws, content, { editNote = '', textChanged = false } = {}) {
    const conn = await canvaConnection(ws.id);
    if (!conn) {
      // Gemini drew the headline on the image, so only a headline change needs a new image.
      if (!editNote && textChanged && post.content?.headline === content.headline) return true;
      const note = editNote || (textChanged ? 'Update the headline text.' : '');
      const previousId = note && post.image?.source === 'gemini' ? post.image.id : null;
      return makeImage(post, ws, content, note ? { editNote: note, previousId } : {});
    }
    let photoId = post.photo_id;
    if (!photoId || editNote || (!textChanged && !editNote && post.image)) {
      const made = await makePhoto(post, ws, content, conn, { editNote });
      if (made) photoId = made;
      else if (!photoId) return false;
    }
    return composeCanva({ ...post, photo_id: photoId }, ws, content, conn, photoId);
  }

  /** The design was edited by hand in Canva: export it again and use it as the post's image. */
  async function importFromCanva(postId, actor) {
    const post = await getPost(postId);
    if (!post?.canva_design_id) throw new ReviewError('This post has no Canva design.');
    if (!['in_review', 'approved', 'scheduled', 'publish_failed'].includes(post.status)) throw new ReviewError('The image can no longer be changed for this post.');
    const row = await db.get(`SELECT * FROM connections WHERE workspace_id = ? AND platform = 'canva'`, [post.workspace_id]);
    if (!row) throw new ReviewError('This brand is no longer connected to Canva.');
    try {
      const saved = await media.saveAny(post.id, await canva.exportJpg(await canvaToken(row), post.canva_design_id), 'canva');
      await db.run('UPDATE posts SET image_id = ?, updated_at = ? WHERE id = ?', [saved.id, now(), post.id]);
      if (post.image_id) await db.run('DELETE FROM media WHERE id = ?', [post.image_id]);
      await addEvent(post.id, 'canva_imported', actor, `${saved.width}×${saved.height}`);
    } catch (err) { throw new ReviewError(err.message); }
    await refreshSlackReview(await getPost(post.id));
  }

  /** Dashboard button: make a new image, or change the current one when a note is given. */
  async function generateImageNow(postId, actor, note = '') {
    const post = await getPost(postId);
    if (!post) throw new ReviewError('Post not found.');
    if (!post.content) throw new ReviewError('The post has no text yet. Wait until it is written.');
    if (!['in_review', 'approved', 'scheduled', 'publish_failed'].includes(post.status)) throw new ReviewError('The image can no longer be changed for this post.');
    if (!(await settings.has('gemini_api_key'))) throw new ReviewError('Add the Gemini API key under Settings first.');
    const ws = await getBrand(post.workspace_id);
    note = String(note || '').trim();
    const machineMade = ['gemini', 'canva'].includes(post.image?.source) || (!post.image && post.photo);
    const edit = note && machineMade;
    const content = note && !edit ? { ...post.content, image_prompt: `${post.content.image_prompt}\n${note}` } : post.content;
    const before = await db.get(`SELECT MAX(id) AS id FROM post_events WHERE post_id = ?`, [post.id]);
    const ok = await makeCreative(post, ws, content, edit ? { editNote: note } : {});
    if (!ok) {
      const last = await db.get(`SELECT note FROM post_events WHERE post_id = ? AND id > ? AND kind IN ('image_failed', 'canva_failed') ORDER BY id DESC LIMIT 1`, [post.id, before?.id || 0]);
      throw new ReviewError(last?.note || 'The image could not be generated.');
    }
    await refreshSlackReview(await getPost(post.id));
  }

  // ---- Requests from Slack ----

  const cleanSlackText = (text) => String(text || '')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<[@#!][^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').trim();

  /** A message posted in a brand's request channel becomes a brief. Returns the new post id, or null if ignored. */
  async function intake({ channel, ts, text }) {
    const ws = await db.get('SELECT * FROM workspaces WHERE slack_request_channel = ?', [String(channel || '')]);
    if (!ws || !/^[\d.]+$/.test(String(ts || ''))) return null;
    const goal = cleanSlackText(text);
    if (goal.length < 10) return null;
    let id;
    try {
      id = await createPost({
        workspaceId: ws.id, actor: 'Slack request', publishAt: null, sourceRef: `slack:${channel}:${ts}`,
        platforms: ['facebook', 'instagram'],
        brief: { goal: goal.slice(0, 1000), details: goal.length > 1000 ? goal.slice(1000, 4000) : '', language: 'Same as the request' },
      });
    } catch (err) {
      if (/unique|duplicate/i.test(err.message)) return null; // Slack sent the same message twice
      throw err;
    }
    const post = await getPost(id);
    const where = ws.slack_channel ? `<#${ws.slack_channel}>` : `the dashboard (<${config.appUrl}/posts/${id}|open>)`;
    await requestThread(post, `Got it. Writing the post${(await settings.has('gemini_api_key')) ? ' and image' : ''} for ${ws.name}. The draft will go to ${where} for approval.`);
    kick();
    return id;
  }

  /** Brand logo, used as a reference for generated images. */
  async function setLogo(brandId, buf) {
    const ws = await getBrand(Number(brandId));
    if (!ws) throw new ReviewError('Brand not found.');
    if (!buf?.length) throw new ReviewError('Choose a logo file to upload.');
    if (buf.length > 2 * 1024 * 1024) throw new ReviewError('That logo is over 2 MB. Export it smaller and try again.');
    let saved;
    try { saved = await media.saveAny(0, buf, 'logo'); } catch { throw new ReviewError('The logo must be a PNG or JPG file.'); }
    await db.run('UPDATE workspaces SET logo_id = ?, updated_at = ? WHERE id = ?', [saved.id, now(), ws.id]);
    if (ws.logo_id) await db.run('DELETE FROM media WHERE id = ?', [ws.logo_id]);
  }

  // ---- Job: write the post ----

  async function runGenerate(job) {
    const post = await getPost(job.post_id);
    if (!post || post.status !== 'generating') return; // decided or removed meanwhile
    const ws = await getBrand(post.workspace_id);
    const payload = parseJson(job.payload, {});
    const model = (await settings.get('claude_model')) || DEFAULT_MODEL;
    const result = await generateContent({
      apiKey: await settings.get('anthropic_api_key'), model, workspace: ws,
      brief: post.brief, platforms: post.platforms,
      previous: payload.note ? post.content : null, note: payload.note || null, fetchImpl,
    });
    const version = post.version + 1;

    // Image: make one if the post has none; on a revision, change it only if the reviewer asked.
    const textOnImageChanged = post.content && (post.content.headline !== result.content.headline || post.content.cta !== result.content.cta);
    if (!post.image) {
      await makeCreative(post, ws, result.content);
    } else if (payload.note && (result.regenerateImage || textOnImageChanged)) {
      if (['gemini', 'canva'].includes(post.image.source)) {
        await makeCreative(post, ws, result.content, result.regenerateImage ? { editNote: payload.note } : { textChanged: true });
      } else if (result.regenerateImage) {
        await addEvent(post.id, 'image_kept', 'System', 'The image was uploaded by hand, so it was not changed. Replace it if it needs to change.');
      }
    }

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

  // ---- Job: publish ----

  async function metaConnection(workspaceId) {
    const row = await db.get(`SELECT * FROM connections WHERE workspace_id = ? AND platform = 'meta'`, [workspaceId]);
    if (!row) return null;
    return { ...row, token: decrypt(row.token, config.secretKey) };
  }

  async function publishOne(post, ws, result, conn) {
    const imageUrl = post.image?.url || null;
    if (!conn) {
      throw Object.assign(new Error(`${ws.name} is not connected to Facebook yet. Connect it on the brand page, then retry.`), { permanent: true });
    }
    if (result.platform === 'facebook') {
      return meta.publishFacebook({ pageId: conn.account_id, token: conn.token, message: captionFor(post, 'facebook'), imageUrl });
    }
    if (result.platform === 'instagram') {
      if (!conn.extra_id) {
        throw Object.assign(new Error(`No Instagram business account is linked to the ${conn.account_name} Facebook Page.`), { permanent: true });
      }
      return meta.publishInstagram({
        igId: conn.extra_id, token: conn.token, caption: captionFor(post, 'instagram'), imageUrl,
        containerId: result.container_id,
        onContainer: (id) => db.run('UPDATE publish_results SET container_id = ?, updated_at = ? WHERE id = ?', [id, now(), result.id]),
      });
    }
    throw Object.assign(new Error(`Publishing to ${PLATFORMS[result.platform]?.label || result.platform} is not connected yet.`), { permanent: true });
  }

  async function runPublish(job) {
    let post = await getPost(job.post_id);
    if (!post || !['scheduled', 'publishing'].includes(post.status)) return;
    if (post.status === 'scheduled') {
      await db.run(`UPDATE posts SET status = 'publishing', updated_at = ? WHERE id = ?`, [now(), post.id]);
      post = await getPost(post.id);
    }
    const ws = await getBrand(post.workspace_id);
    const conn = await metaConnection(post.workspace_id);
    const pending = await db.all(`SELECT * FROM publish_results WHERE post_id = ? AND status = 'pending' ORDER BY id`, [post.id]);
    let retryLater = null;
    for (const r of pending) {
      try {
        const out = await publishOne(post, ws, r, conn);
        await db.run(`UPDATE publish_results SET status = 'published', remote_id = ?, url = ?, error = NULL, updated_at = ? WHERE id = ?`,
          [out.id, out.url, now(), r.id]);
        await addEvent(post.id, 'published', PLATFORMS[r.platform].label, out.url || '');
      } catch (err) {
        if (err.permanent || job.attempts >= MAX_ATTEMPTS) {
          await db.run(`UPDATE publish_results SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, [err.message, now(), r.id]);
          await addEvent(post.id, 'publish_failed', PLATFORMS[r.platform].label, err.message);
        } else {
          await db.run(`UPDATE publish_results SET error = ?, updated_at = ? WHERE id = ?`, [err.message, now(), r.id]);
          retryLater = err;
        }
      }
    }
    if (retryLater) throw retryLater; // the queue retries the platforms still pending
    await finishPublish(post.id);
  }

  async function finishPublish(postId) {
    const results = await db.all('SELECT * FROM publish_results WHERE post_id = ? ORDER BY id', [postId]);
    const failed = results.filter((r) => r.status === 'failed');
    const published = results.filter((r) => r.status === 'published');
    const status = failed.length ? 'publish_failed' : 'published';
    await db.run(`UPDATE posts SET status = ?, updated_at = ? WHERE id = ? AND status = 'publishing'`, [status, now(), postId]);
    const post = await getPost(postId);
    const lines = [
      ...published.map((r) => `✅ ${PLATFORMS[r.platform].label}: ${r.url ? `<${r.url}|view post>` : 'published'}`),
      ...failed.map((r) => `⚠️ ${PLATFORMS[r.platform].label}: ${r.error}`),
      ...results.filter((r) => r.status === 'skipped').map((r) => `➖ ${PLATFORMS[r.platform].label}: ${r.error}`),
    ];
    const summary = `${failed.length ? 'Publishing finished with problems' : 'Published'}\n${lines.join('\n')}\n<${config.appUrl}/posts/${postId}|Open in dashboard>`;
    await slackThread(post, summary);
    await requestThread(post, summary);
  }

  const handlers = { generate: runGenerate, publish: runPublish };

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
      if (giveUp && job.post_id && job.kind === 'generate') {
        const failed = await db.run(`UPDATE posts SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'generating'`,
          [err.message, now(), job.post_id]);
        if (failed.changes) {
          await addEvent(job.post_id, 'failed', 'System', err.message);
          await requestThread(await getPost(job.post_id), `I could not write this post: ${err.message}`);
        }
      }
      if (giveUp && job.post_id && job.kind === 'publish') {
        await db.run(`UPDATE publish_results SET status = 'failed', error = COALESCE(error, ?), updated_at = ? WHERE post_id = ? AND status = 'pending'`,
          [err.message, now(), job.post_id]);
        await finishPublish(job.post_id).catch(() => {});
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

  /** Problems that would stop the post going out, checked before approval. */
  function approvalProblem(post) {
    if (post.platforms.includes('instagram')) return instagramProblem(post.image);
    return '';
  }

  async function approve(postId, actor) {
    const current = await getPost(postId);
    if (!current) throw new ReviewError('Post not found.');
    if (current.status === 'in_review') {
      const problem = approvalProblem(current);
      if (problem) throw new ReviewError(problem);
    }
    const post = await decide(postId, 'approved', actor);
    await addEvent(post.id, 'approved', actor);
    const ws = await getBrand(post.workspace_id);

    // One result row per platform. Platforms without publishing yet are recorded as skipped.
    for (const p of post.platforms) {
      const supported = PUBLISHABLE.includes(p);
      await db.run('INSERT INTO publish_results (post_id, platform, status, error, updated_at) VALUES (?, ?, ?, ?, ?)',
        [post.id, p, supported ? 'pending' : 'skipped', supported ? null : `Publishing to ${PLATFORMS[p].label} is not connected yet.`, now()]);
    }
    const scheduled = post.publish_at && post.publish_at > now();
    await db.run(`UPDATE posts SET status = ?, updated_at = ? WHERE id = ?`, [scheduled ? 'scheduled' : 'publishing', now(), post.id]);
    await enqueue('publish', post.id, {}, 0, scheduled ? post.publish_at : null);
    await updateSlack(post, scheduled
      ? `Approved by ${actor} · publishes ${formatTime(post.publish_at, ws.timezone)}`
      : `Approved by ${actor} · publishing now`);
    if (!scheduled) kick();
    return getPost(post.id);
  }

  async function reject(postId, actor, note = '') {
    const post = await decide(postId, 'rejected', actor);
    await addEvent(post.id, 'rejected', actor, note);
    await updateSlack(post, `Rejected by ${actor}${note ? `: ${note}` : ''}`);
    await requestThread(post, `Rejected by ${actor}${note ? `: ${note}` : ''}. Post a new request to start again.`);
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

  /** Try a post whose writing failed again. */
  async function retry(postId, actor) {
    const post = await getPost(postId);
    const done = await db.run(`UPDATE posts SET status = 'generating', error = NULL, updated_at = ? WHERE id = ? AND status = 'failed'`, [now(), Number(postId)]);
    if (!done.changes) throw new ReviewError('Only failed posts can be retried.');
    await addEvent(post.id, 'retried', actor);
    // A failed revision keeps its reviewer note so the retry applies the same changes.
    const last = await db.get(`SELECT payload FROM jobs WHERE post_id = ? AND kind = 'generate' ORDER BY id DESC LIMIT 1`, [post.id]);
    await enqueue('generate', post.id, parseJson(last?.payload, {}));
    kick();
  }

  /** Publish again to the platforms that failed. */
  async function retryPublish(postId, actor) {
    const done = await db.run(`UPDATE posts SET status = 'publishing', updated_at = ? WHERE id = ? AND status = 'publish_failed'`, [now(), Number(postId)]);
    if (!done.changes) throw new ReviewError('Only posts that failed to publish can be retried.');
    await db.run(`UPDATE publish_results SET status = 'pending', error = NULL, updated_at = ? WHERE post_id = ? AND status = 'failed'`, [now(), Number(postId)]);
    await addEvent(Number(postId), 'publish_retried', actor);
    await enqueue('publish', Number(postId));
    kick();
  }

  // ---- Images ----

  const EDITABLE = ['generating', 'in_review', 'approved', 'scheduled', 'publish_failed', 'failed'];

  async function setImage(postId, buf, actor) {
    const post = await getPost(postId);
    if (!post) throw new ReviewError('Post not found.');
    if (!EDITABLE.includes(post.status)) throw new ReviewError('The image can no longer be changed for this post.');
    let saved;
    try { saved = await media.save(post.id, buf); } catch (err) { throw new ReviewError(err.message); }
    await db.run('UPDATE posts SET image_id = ?, updated_at = ? WHERE id = ?', [saved.id, now(), post.id]);
    if (post.image_id) await db.run('DELETE FROM media WHERE id = ?', [post.image_id]);
    await addEvent(post.id, 'image_added', actor, `${saved.width}×${saved.height}`);
    const updated = await getPost(post.id);
    await refreshSlackReview(updated);
    return updated;
  }

  async function removeImage(postId, actor) {
    const post = await getPost(postId);
    if (!post?.image_id) return;
    if (!EDITABLE.includes(post.status)) throw new ReviewError('The image can no longer be changed for this post.');
    await db.run('UPDATE posts SET image_id = NULL, updated_at = ? WHERE id = ?', [now(), post.id]);
    await db.run('DELETE FROM media WHERE id = ?', [post.image_id]);
    await addEvent(post.id, 'image_removed', actor);
    await refreshSlackReview(await getPost(post.id));
  }

  async function publishResults(postId) {
    return db.all('SELECT * FROM publish_results WHERE post_id = ? ORDER BY id', [Number(postId)]);
  }

  return {
    getPost, createPost, approve, reject, requestChanges, retry, retryPublish,
    setImage, removeImage, publishResults, drain, kick, addEvent, media, meta,
    generateImageNow, intake, setLogo, importFromCanva, canva, canvaToken,
  };
}
