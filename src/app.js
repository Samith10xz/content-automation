import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, parseCookies, readBody, parseForm, send, sendHtml, sendJson, redirect } from './http.js';
import { hashPassword, verifyPassword } from './security.js';
import { createSettings } from './settings.js';
import { createSlack, verifySlackSignature } from './services/slack.js';
import { DEFAULT_MODEL, testClaude } from './services/claude.js';
import { createEngine, ReviewError } from './engine.js';
import * as views from './views.js';
import { PLATFORMS, STATUS_LABELS, now, randomToken, safeEqual, parseJson, localToUtc, isValidTimeZone } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DAYS = 14;
const COLOR = /^#[0-9a-fA-F]{6}$/;

export function createApp({ db, config, fetchImpl = fetch, log = console, autoKick = true }) {
  const settings = createSettings(db, config.secretKey);
  const slack = createSlack({ fetchImpl });
  const engine = createEngine({ db, settings, slack, config, fetchImpl, log, autoKick });
  const router = new Router();
  const css = fs.readFileSync(path.join(here, '..', 'public', 'app.css'));
  const loginAttempts = new Map(); // ip -> { count, resetAt }

  // ---------- helpers ----------

  const cookie = (value, maxAge) =>
    `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;

  async function loadSession(req) {
    const sid = parseCookies(req.headers.cookie).sid;
    if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
    const row = await db.get(
      `SELECT s.id AS sid, s.csrf, u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`,
      [sid, now()]);
    return row ? { sid: row.sid, csrf: row.csrf, user: { id: row.id, email: row.email, name: row.name, role: row.role } } : null;
  }

  async function startSession(res, userId) {
    const sid = randomToken(32);
    await db.run('INSERT INTO sessions (id, user_id, csrf, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      [sid, userId, randomToken(24), now(SESSION_DAYS * 86400_000), now()]);
    await db.run('DELETE FROM sessions WHERE expires_at < ?', [now()]);
    return cookie(sid, SESSION_DAYS * 86400);
  }

  const userCount = async () => Number((await db.get('SELECT COUNT(*) AS n FROM users')).n);
  const listBrands = () => db.all('SELECT * FROM workspaces ORDER BY name');
  const getBrand = (id) => db.get('SELECT * FROM workspaces WHERE id = ?', [Number(id) || 0]);
  const withMsg = (url, key, text) => `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(text)}`;

  function render(ctx, { title, active, body, refresh, status = 200 }) {
    sendHtml(ctx.res, status, views.layout({
      title, active, body, refresh, user: ctx.session.user, csrf: ctx.session.csrf,
      msg: ctx.query.get('msg'), err: ctx.query.get('err'),
    }));
  }

  const notFound = (ctx) => sendHtml(ctx.res, 404, views.messagePage({ title: 'Not found', heading: 'Page not found', text: 'That page does not exist or was removed.', status: 404 }));

  function brandFromForm(body, base = {}) {
    const text = (k, max) => String(body[k] ?? '').trim().slice(0, max);
    return {
      ...base,
      name: text('name', 100),
      timezone: text('timezone', 64) || 'Asia/Colombo',
      primary_color: text('primary_color', 9),
      secondary_color: text('secondary_color', 9),
      tone: text('tone', 2000), audience: text('audience', 2000),
      banned_words: text('banned_words', 1000), sample_posts: text('sample_posts', 6000),
      slack_channel: text('slack_channel', 30),
    };
  }

  function brandError(b) {
    if (!b.name) return 'Give the brand a name.';
    if (!COLOR.test(b.primary_color) || !COLOR.test(b.secondary_color)) return 'Pick both brand colours.';
    if (!isValidTimeZone(b.timezone)) return 'That time zone is not recognised. Example: Asia/Colombo.';
    if (b.slack_channel && !/^[CG][A-Z0-9]{6,}$/.test(b.slack_channel)) return 'A Slack channel ID looks like C0123ABCD (not the channel name).';
    return '';
  }

  // ---------- public routes ----------

  router.get('/health', async (ctx) => {
    let dbOk = true;
    try { await db.get('SELECT 1 AS ok'); } catch { dbOk = false; }
    sendJson(ctx.res, dbOk ? 200 : 503, { ok: dbOk, db: dbOk, version: '0.1.0' });
  }, { public: true });

  router.get('/setup', async (ctx) => {
    if (await userCount()) return redirect(ctx.res, '/login');
    const token = ctx.query.get('token') || '';
    if (!config.setupToken || !safeEqual(token, config.setupToken)) {
      return sendHtml(ctx.res, 403, views.messagePage({ title: 'Setup', heading: 'Setup link needed', text: 'Open the one-time setup link you were given to create the owner account.' }));
    }
    sendHtml(ctx.res, 200, views.setupPage({ token }));
  }, { public: true });

  router.post('/setup', async (ctx) => {
    if (await userCount()) return redirect(ctx.res, '/login');
    const { token = '', name = '', email = '', password = '' } = ctx.body;
    if (!config.setupToken || !safeEqual(token, config.setupToken)) return send(ctx.res, 403, 'Forbidden');
    const values = { name: String(name).trim().slice(0, 100), email: String(email).trim().toLowerCase().slice(0, 190) };
    const err = !values.name ? 'Enter your name.'
      : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email) ? 'Enter a valid email address.'
      : String(password).length < 10 ? 'Use a password of at least 10 characters.' : '';
    if (err) return sendHtml(ctx.res, 400, views.setupPage({ token, err, values }));
    const { insertId } = await db.run('INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
      [values.email, values.name, await hashPassword(String(password)), 'owner', now()]);
    redirect(ctx.res, '/', { 'set-cookie': await startSession(ctx.res, insertId) });
  }, { public: true });

  router.get('/login', async (ctx) => {
    if (ctx.session) return redirect(ctx.res, '/');
    sendHtml(ctx.res, 200, views.loginPage({ hasUsers: (await userCount()) > 0, msg: ctx.query.get('msg') }));
  }, { public: true });

  router.post('/login', async (ctx) => {
    const ip = String(ctx.req.headers['x-forwarded-for'] || ctx.req.socket.remoteAddress || '').split(',')[0].trim();
    const entry = loginAttempts.get(ip);
    if (entry && entry.resetAt > Date.now() && entry.count >= 10) {
      return sendHtml(ctx.res, 429, views.loginPage({ hasUsers: true, err: 'Too many attempts. Wait 15 minutes and try again.' }));
    }
    const email = String(ctx.body.email || '').trim().toLowerCase();
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    const ok = user ? await verifyPassword(String(ctx.body.password || ''), user.password_hash) : false;
    if (!ok) {
      const cur = entry && entry.resetAt > Date.now() ? entry : { count: 0, resetAt: Date.now() + 15 * 60_000 };
      cur.count++; loginAttempts.set(ip, cur);
      return sendHtml(ctx.res, 401, views.loginPage({ hasUsers: true, email, err: 'That email and password do not match.' }));
    }
    loginAttempts.delete(ip);
    redirect(ctx.res, '/', { 'set-cookie': await startSession(ctx.res, user.id) });
  }, { public: true });

  router.post('/logout', async (ctx) => {
    await db.run('DELETE FROM sessions WHERE id = ?', [ctx.session.sid]);
    redirect(ctx.res, withMsg('/login', 'msg', 'You are signed out.'), { 'set-cookie': cookie('', 0) });
  });

  // ---------- posts ----------

  router.get('/', async (ctx) => {
    const brands = await listBrands();
    const brand = brands.find((b) => String(b.id) === ctx.query.get('brand'));
    const status = STATUS_LABELS[ctx.query.get('status')] ? ctx.query.get('status') : '';
    const where = []; const params = [];
    if (brand) { where.push('p.workspace_id = ?'); params.push(brand.id); }
    const countRows = await db.all(`SELECT p.status, COUNT(*) AS n FROM posts p ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY p.status`, params);
    if (status) { where.push('p.status = ?'); params.push(status); }
    const rows = await db.all(
      `SELECT p.*, w.name AS brand_name, w.timezone FROM posts p JOIN workspaces w ON w.id = p.workspace_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.updated_at DESC, p.id DESC LIMIT 100`, params);
    const posts = rows.map((r) => ({
      ...r, brief: parseJson(r.brief, {}), content: parseJson(r.content, null),
      platforms: String(r.platforms).split(',').filter((p) => PLATFORMS[p]),
    }));
    render(ctx, {
      title: 'Posts', active: 'posts',
      refresh: posts.some((p) => p.status === 'generating') ? 6 : 0,
      body: views.dashboardBody({
        posts, brands, filter: { brand: brand?.id || '', status },
        counts: Object.fromEntries(countRows.map((r) => [r.status, Number(r.n)])),
        claudeReady: await settings.has('anthropic_api_key'),
      }),
    });
  });

  router.get('/posts/new', async (ctx) => {
    const brands = await listBrands();
    if (!brands.length) return redirect(ctx.res, '/brands/new');
    render(ctx, { title: 'New brief', active: 'posts', body: views.newPostBody({ brands, csrf: ctx.session.csrf, values: { brand: ctx.query.get('brand') } }) });
  });

  router.post('/posts', async (ctx) => {
    const b = ctx.body;
    const brands = await listBrands();
    const brand = brands.find((x) => String(x.id) === String(b.brand));
    const platforms = [].concat(b.platforms || []).filter((p) => PLATFORMS[p]);
    const values = {
      brand: b.brand, platforms, publish_at: String(b.publish_at || ''),
      goal: String(b.goal || '').trim().slice(0, 1000), details: String(b.details || '').trim().slice(0, 3000),
      language: ['English', 'Sinhala', 'Tamil'].includes(b.language) ? b.language : 'English',
    };
    const publishAt = values.publish_at ? localToUtc(values.publish_at, brand?.timezone || 'Asia/Colombo') : null;
    const err = !brand ? 'Choose a brand.'
      : !values.goal ? 'Say what the post is about.'
      : !platforms.length ? 'Choose at least one platform.'
      : values.publish_at && !publishAt ? 'That publish time is not valid.'
      : publishAt && publishAt < now() ? 'The publish time is in the past.' : '';
    if (err) {
      ctx.res.statusCode = 400;
      return render(ctx, { title: 'New brief', active: 'posts', status: 400, body: views.newPostBody({ brands, csrf: ctx.session.csrf, err, values }) });
    }
    const id = await engine.createPost({
      workspaceId: brand.id, actor: ctx.session.user.name, platforms, publishAt,
      brief: { goal: values.goal, details: values.details, language: values.language },
    });
    engine.kick();
    redirect(ctx.res, `/posts/${id}`);
  });

  router.get('/posts/:id', async (ctx) => {
    const post = await engine.getPost(ctx.params.id);
    if (!post) return notFound(ctx);
    const brand = await getBrand(post.workspace_id);
    const events = await db.all('SELECT * FROM post_events WHERE post_id = ? ORDER BY id DESC', [post.id]);
    render(ctx, {
      title: post.content?.headline || 'Post', active: 'posts', refresh: post.status === 'generating' ? 4 : 0,
      body: views.postBody({ post, brand, events, csrf: ctx.session.csrf }),
    });
  });

  const reviewAction = (fn, okMsg) => async (ctx) => {
    const back = `/posts/${Number(ctx.params.id) || 0}`;
    try {
      await fn(ctx);
      redirect(ctx.res, withMsg(back, 'msg', okMsg));
    } catch (err) {
      if (!(err instanceof ReviewError)) throw err;
      redirect(ctx.res, withMsg(back, 'err', err.message));
    }
  };
  router.post('/posts/:id/approve', reviewAction((ctx) => engine.approve(ctx.params.id, ctx.session.user.name), 'Post approved.'));
  router.post('/posts/:id/reject', reviewAction((ctx) => engine.reject(ctx.params.id, ctx.session.user.name, String(ctx.body.note || '').trim().slice(0, 500)), 'Post rejected.'));
  router.post('/posts/:id/changes', reviewAction((ctx) => engine.requestChanges(ctx.params.id, ctx.session.user.name, String(ctx.body.note || '').slice(0, 1500)), 'Changes requested. Claude is rewriting the post.'));
  router.post('/posts/:id/retry', reviewAction((ctx) => engine.retry(ctx.params.id, ctx.session.user.name), 'Trying again.'));

  // ---------- brands ----------

  router.get('/brands', async (ctx) => {
    const brands = await db.all(
      `SELECT w.*, (SELECT COUNT(*) FROM posts p WHERE p.workspace_id = w.id) AS post_count FROM workspaces w ORDER BY w.name`);
    render(ctx, { title: 'Brands', active: 'brands', body: views.brandsBody({ brands }) });
  });

  const blankBrand = { name: '', timezone: 'Asia/Colombo', primary_color: '#2f43b8', secondary_color: '#f5b700', tone: '', audience: '', banned_words: '', sample_posts: '', slack_channel: '' };

  router.get('/brands/new', async (ctx) => {
    render(ctx, { title: 'Add a brand', active: 'brands', body: views.brandFormBody({ brand: blankBrand, csrf: ctx.session.csrf, slackReady: await settings.has('slack_bot_token') }) });
  });

  router.post('/brands', async (ctx) => {
    const b = brandFromForm(ctx.body);
    const err = brandError(b);
    if (err) return render(ctx, { title: 'Add a brand', active: 'brands', status: 400, body: views.brandFormBody({ brand: b, csrf: ctx.session.csrf, err, slackReady: await settings.has('slack_bot_token') }) });
    await db.run(
      `INSERT INTO workspaces (name, timezone, primary_color, secondary_color, tone, audience, banned_words, sample_posts, slack_channel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.name, b.timezone, b.primary_color, b.secondary_color, b.tone, b.audience, b.banned_words, b.sample_posts, b.slack_channel || null, now(), now()]);
    redirect(ctx.res, withMsg('/brands', 'msg', `${b.name} added.`));
  });

  router.get('/brands/:id', async (ctx) => {
    const brand = await getBrand(ctx.params.id);
    if (!brand) return notFound(ctx);
    render(ctx, { title: brand.name, active: 'brands', body: views.brandFormBody({ brand, csrf: ctx.session.csrf, slackReady: await settings.has('slack_bot_token') }) });
  });

  router.post('/brands/:id', async (ctx) => {
    const existing = await getBrand(ctx.params.id);
    if (!existing) return notFound(ctx);
    const b = brandFromForm(ctx.body, { id: existing.id });
    const err = brandError(b);
    if (err) return render(ctx, { title: existing.name, active: 'brands', status: 400, body: views.brandFormBody({ brand: b, csrf: ctx.session.csrf, err, slackReady: await settings.has('slack_bot_token') }) });
    await db.run(
      `UPDATE workspaces SET name = ?, timezone = ?, primary_color = ?, secondary_color = ?, tone = ?, audience = ?, banned_words = ?, sample_posts = ?, slack_channel = ?, updated_at = ? WHERE id = ?`,
      [b.name, b.timezone, b.primary_color, b.secondary_color, b.tone, b.audience, b.banned_words, b.sample_posts, b.slack_channel || null, now(), existing.id]);
    redirect(ctx.res, withMsg(`/brands/${existing.id}`, 'msg', 'Brand saved.'));
  });

  // ---------- settings ----------

  router.get('/settings', async (ctx) => {
    render(ctx, {
      title: 'Settings', active: 'settings',
      body: views.settingsBody({
        csrf: ctx.session.csrf, appUrl: config.appUrl,
        state: {
          claudeKey: await settings.has('anthropic_api_key'),
          model: (await settings.get('claude_model')) || DEFAULT_MODEL,
          slackToken: await settings.has('slack_bot_token'),
          slackSecret: await settings.has('slack_signing_secret'),
          lastTick: await settings.get('last_cron_tick'),
        },
      }),
    });
  });

  async function saveClaude(ctx) {
    const key = String(ctx.body.anthropic_api_key || '').trim();
    const model = String(ctx.body.claude_model || '').trim();
    if (!/^[a-zA-Z0-9.\-_]{3,80}$/.test(model)) throw new ReviewError('That model name is not valid.');
    if (key) await settings.set('anthropic_api_key', key);
    await settings.set('claude_model', model);
  }
  async function saveSlack(ctx) {
    for (const k of ['slack_bot_token', 'slack_signing_secret']) {
      const v = String(ctx.body[k] || '').trim();
      if (v) await settings.set(k, v);
    }
  }
  const settingsAction = (fn) => async (ctx) => {
    try { redirect(ctx.res, withMsg('/settings', 'msg', await fn(ctx))); }
    catch (err) { redirect(ctx.res, withMsg('/settings', 'err', err.message)); }
  };
  router.post('/settings/claude', settingsAction(async (ctx) => { await saveClaude(ctx); return 'Claude settings saved.'; }));
  router.post('/settings/claude/test', settingsAction(async (ctx) => {
    await saveClaude(ctx);
    const model = await testClaude({ apiKey: await settings.get('anthropic_api_key'), model: await settings.get('claude_model'), fetchImpl });
    return `Claude is connected (${model}).`;
  }));
  router.post('/settings/slack', settingsAction(async (ctx) => { await saveSlack(ctx); return 'Slack settings saved.'; }));
  router.post('/settings/slack/test', settingsAction(async (ctx) => {
    await saveSlack(ctx);
    const info = await slack.test(await settings.get('slack_bot_token'));
    return `Slack is connected to ${info.team || 'your workspace'} as ${info.user || 'the app'}.`;
  }));

  // ---------- machine endpoints ----------

  router.get('/api/cron/tick', async (ctx) => {
    if (!config.cronSecret || !safeEqual(ctx.query.get('key') || '', config.cronSecret)) return sendJson(ctx.res, 403, { ok: false });
    const ran = await engine.drain();
    await settings.set('last_cron_tick', now());
    sendJson(ctx.res, 200, { ok: true, ran });
  }, { public: true });

  router.post('/api/slack/interactions', async (ctx) => {
    const valid = verifySlackSignature({
      signingSecret: await settings.get('slack_signing_secret'),
      timestamp: ctx.req.headers['x-slack-request-timestamp'],
      signature: ctx.req.headers['x-slack-signature'],
      rawBody: ctx.rawBody,
    });
    if (!valid) return send(ctx.res, 401, 'Invalid signature');
    const payload = parseJson(ctx.body.payload, null);
    if (!payload) return send(ctx.res, 400, 'Bad payload');
    const actor = `${payload.user?.name || payload.user?.username || 'Someone'} (Slack)`;
    const token = await settings.get('slack_bot_token');

    if (payload.type === 'view_submission' && payload.view?.callback_id === 'changes_modal') {
      const note = payload.view.state?.values?.note?.value?.value || '';
      try {
        await engine.requestChanges(payload.view.private_metadata, actor, note);
        return send(ctx.res, 200, '');
      } catch (err) {
        if (!(err instanceof ReviewError)) throw err;
        return sendJson(ctx.res, 200, { response_action: 'errors', errors: { note: err.message } });
      }
    }

    if (payload.type === 'block_actions') {
      const action = payload.actions?.[0] || {};
      send(ctx.res, 200, ''); // Slack needs an answer within 3 seconds; the work continues below.
      try {
        if (action.action_id === 'approve') await engine.approve(action.value, actor);
        else if (action.action_id === 'reject') await engine.reject(action.value, actor);
        else if (action.action_id === 'changes') await slack.openChangesModal(token, payload.trigger_id, action.value);
      } catch (err) {
        if (err instanceof ReviewError) await slack.respond(payload.response_url, err.message);
        else log.error('slack action failed', err.message);
      }
      return;
    }
    send(ctx.res, 200, '');
  }, { public: true, machine: true });

  // ---------- request handling ----------

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname;
    try {
      if (req.method === 'GET' && pathname === '/app.css') {
        return send(res, 200, css, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300' });
      }
      const { route, params, pathMatched } = router.match(req.method, pathname);
      if (!route) {
        if (pathMatched) return send(res, 405, 'Method not allowed');
        return sendHtml(res, 404, views.messagePage({ title: 'Not found', heading: 'Page not found', text: 'That page does not exist.', status: 404 }));
      }
      const ctx = { req, res, params, query: url.searchParams, body: {}, rawBody: '', session: null };
      if (req.method === 'POST') {
        ctx.rawBody = await readBody(req);
        ctx.body = parseForm(ctx.rawBody, req.headers['content-type'] || '');
      }
      if (!route.opts.machine) ctx.session = await loadSession(req);
      if (!route.opts.public) {
        if (!ctx.session) return redirect(res, '/login');
        if (req.method === 'POST' && !safeEqual(ctx.body._csrf || '', ctx.session.csrf)) {
          return sendHtml(res, 403, views.messagePage({ title: 'Expired', heading: 'This form expired', text: 'Go back, reload the page and try again.' }));
        }
      }
      await route.handler(ctx);
    } catch (err) {
      log.error(`${req.method} ${pathname} failed:`, err);
      if (res.headersSent) return res.end();
      const status = err.status || 500;
      sendHtml(res, status, views.messagePage({ title: 'Error', heading: status === 413 ? 'That was too large' : 'Something went wrong', text: status === 413 ? 'Shorten the text and try again.' : 'The error was logged. Try again in a moment.' }));
    }
  }

  return { handle, engine, settings };
}
