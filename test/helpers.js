import http from 'node:http';
import crypto from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMeta } from '../src/services/meta.js';
import { createCanva } from '../src/services/canva.js';

/** Fake Claude + Slack. `state` lets a test inspect calls and force failures. */
export function fakeFetch(state) {
  return async (url, init) => {
    const body = init?.body && String(init.headers?.['content-type'] || '').includes('json') ? JSON.parse(init.body) : {};
    state.calls.push({ url, body });
    const json = (status, data) => ({ ok: status < 400, status, json: async () => data });
    if (url.includes('api.anthropic.com')) {
      if (state.claudeStatus) return json(state.claudeStatus, { error: { message: 'boom' } });
      if (!body.tools) return json(200, { model: body.model, content: [{ type: 'text', text: 'OK' }] });
      const platforms = body.tools[0].input_schema.properties.captions.required;
      const revision = body.messages[0].content.includes('This is a revision');
      const wantsImage = revision && /image|picture|background/i.test(body.messages[0].content.split('The reviewer asked for these changes:')[1] || '');
      return json(200, {
        model: body.model, usage: { input_tokens: 120, output_tokens: 80 },
        content: [{ type: 'tool_use', name: 'save_post', input: {
          headline: revision ? 'Shorter headline' : 'Free pickup this December',
          image_prompt: 'A courier handing over a parcel',
          captions: Object.fromEntries(platforms.map((p) => [p, `Caption for ${p}${revision ? ' v2' : ''}`])),
          hashtags: ['#ParcelLK', 'shipping'], cta: 'Book now', regenerate_image: wantsImage,
        } }],
      });
    }
    if (url.includes('export-download.canva.com')) {
      state.exports++;
      return { ok: true, status: 200, arrayBuffer: async () => makeJpeg(1200 + state.exports, 630) };
    }
    if (url.includes('api.canva.com')) {
      const path = new URL(url).pathname.replace('/rest/v1', '');
      const method = init?.method || 'GET';
      const form = String(init?.headers?.['content-type'] || '').includes('urlencoded') ? Object.fromEntries(new URLSearchParams(init.body)) : null;
      state.canva.push({ method, path, body: form || body, auth: init?.headers?.authorization });
      if (path === '/oauth/token') {
        if (form.grant_type === 'refresh_token' && form.refresh_token !== state.canvaRefresh) return json(400, { code: 'invalid_grant', message: 'bad refresh token' });
        state.canvaRefresh = `refresh-${state.canva.length}`;
        return json(200, { access_token: `access-${state.canva.length}`, refresh_token: state.canvaRefresh, expires_in: 14400 });
      }
      if (path === '/users/me') return json(200, { team_user: { user_id: 'CU1', team_id: 'CT1' } });
      if (path === '/users/me/profile') return json(200, { profile: { display_name: 'GTV Designs' } });
      if (path === '/users/me/capabilities') return json(200, { capabilities: state.canvaCaps });
      if (path === '/brand-templates') return json(200, { items: [{ id: 'TPL1', title: 'FB offer post', thumbnail: { url: 'https://x/t.png' } }, { id: 'TPL2', title: 'Story' }] });
      if (path === '/brand-templates/TPL1/dataset') return json(200, { dataset: { PHOTO: { type: 'image' }, HEADLINE: { type: 'text' }, CTA_BUTTON: { type: 'text' }, SALES: { type: 'chart' } } });
      if (path === '/url-asset-uploads' && method === 'POST') return json(200, { job: { id: 'up1', status: 'in_progress' } });
      if (path === '/url-asset-uploads/up1') return json(200, { job: { id: 'up1', status: 'success', asset: { id: 'ASSET1' } } });
      if (path === '/autofills' && method === 'POST') {
        if (state.canvaFail) return json(200, { job: { id: 'af1', status: 'failed', error: { code: state.canvaFail, message: 'nope' } } });
        return json(200, { job: { id: 'af1', status: 'in_progress' } });
      }
      if (path === '/autofills/af1') { state.designs++; return json(200, { job: { id: 'af1', status: 'success', result: { type: 'create_design', design: { id: `DES${state.designs}`, urls: { edit_url: 'https://www.canva.com/api/design/abc/edit' } } } } }); }
      if (path === '/exports' && method === 'POST') return json(200, { job: { id: 'ex1', status: 'success', urls: ['https://export-download.canva.com/file.jpg'] } });
      return json(404, { code: 'not_found', message: `unknown ${path}` });
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      if (url.includes('/models/')) return state.geminiStatus ? json(state.geminiStatus, { error: { message: 'API key not valid' } }) : json(200, { displayName: 'Nano Banana 2.1' });
      if (state.geminiStatus) return json(state.geminiStatus, { error: { message: 'quota exceeded' } });
      state.images++;
      return json(200, { status: 'completed', steps: [
        { type: 'thought', summary: [{ type: 'image', data: 'x'.repeat(400) }] },
        { type: 'model_output', content: [{ type: 'image', mime_type: 'image/jpeg', data: makeJpeg(896 + state.images, 1120).toString('base64') }] },
      ] });
    }
    if (url.includes('graph.facebook.com')) {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/v[\d.]+\//, '');
      const form = init?.body ? Object.fromEntries(new URLSearchParams(init.body)) : Object.fromEntries(u.searchParams);
      state.graph.push({ method: init?.method || 'GET', path, form });
      const fail = state.metaFail?.[path];
      if (fail) return json(fail.status || 400, { error: fail.error });
      if (path === 'oauth/access_token') return json(200, { access_token: form.grant_type ? 'long-user-token' : 'short-user-token' });
      if (path === 'me/accounts') return json(200, { data: state.pages });
      if (path === '111/photos') return json(200, { id: 'photo1', post_id: '111_555' });
      if (path === '111/feed') return json(200, { id: '111_556' });
      if (path === '999/media') return json(200, { id: 'container1' });
      if (path === 'container1') return json(200, { status_code: state.igStatus.shift() || 'FINISHED' });
      if (path === '999/media_publish') return json(200, { id: 'igmedia1' });
      if (path === 'igmedia1') return json(200, { permalink: 'https://www.instagram.com/p/abc123/' });
      return json(404, { error: { message: `unknown ${path}`, code: 100 } });
    }
    if (url.includes('slack.com/api/chat.postMessage')) return json(200, state.slackFail ? { ok: false, error: 'channel_not_found' } : { ok: true, channel: body.channel, ts: '111.222' });
    if (url.includes('slack.com/api/')) return json(200, { ok: true, team: 'GTV', user: 'pipeline' });
    return json(200, {});
  };
}

export async function makeApp(env = {}) {
  const state = {
    calls: [], claudeStatus: 0, slackFail: false, graph: [], metaFail: {}, igStatus: [], geminiStatus: 0, images: 0,
    canva: [], canvaCaps: ['autofill', 'brand_template'], canvaFail: '', canvaRefresh: '', exports: 0, designs: 0,
    pages: [{ id: '111', name: 'Parcel.lk', access_token: 'page-token', instagram_business_account: { id: '999', username: 'parcel.lk' } }],
  };
  const config = loadConfig({ SECRET_KEY: 'a'.repeat(64), SETUP_TOKEN: 'setup-token', CRON_SECRET: 'cron-secret', APP_URL: 'http://localhost', ...env });
  const db = await openDb(config.db);
  const fetchImpl = fakeFetch(state);
  const meta = createMeta({ fetchImpl, sleep: async () => {}, pollMs: 0, pollTries: 3 });
  const canva = createCanva({ fetchImpl, sleep: async () => {}, pollMs: 0, pollTries: 5 });
  const app = createApp({ db, config, fetchImpl, log: { error() {} }, autoKick: false, meta, canva });
  return { app, db, state, config };
}

export async function addBrand(db, over = {}) {
  const t = '2026-01-01 00:00:00';
  const b = { name: 'Parcel.LK', timezone: 'Asia/Colombo', primary_color: '#2f43b8', secondary_color: '#f5b700', slack_channel: null, ...over };
  const { insertId } = await db.run(
    `INSERT INTO workspaces (name, timezone, primary_color, secondary_color, tone, audience, banned_words, sample_posts, slack_channel, created_at, updated_at) VALUES (?, ?, ?, ?, '', '', '', '', ?, ?, ?)`,
    [b.name, b.timezone, b.primary_color, b.secondary_color, b.slack_channel, t, t]);
  return insertId;
}

/** Start the app on a random port and return a tiny cookie-keeping client. */
export async function serve(app) {
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function request(method, path, form, headers = {}) {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      body: form ? (typeof form === 'string' || Buffer.isBuffer(form) ? form : new URLSearchParams(form).toString()) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  return { base, get: (p) => request('GET', p), post: (p, f, h) => request('POST', p, f, h), raw: request, close: () => new Promise((r) => server.close(r)) };
}

export const csrfOf = (html) => /name="_csrf" value="([a-f0-9]+)"/.exec(html)?.[1];

export function slackSign(secret, rawBody, ts = Math.floor(Date.now() / 1000)) {
  return {
    'x-slack-request-timestamp': String(ts),
    'x-slack-signature': 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex'),
  };
}

/** A minimal valid JPEG header with the given size (enough for the size check and for storage). */
export function makeJpeg(width, height) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(400, 0), Buffer.from([0xff, 0xd9])]);
}

/** Connect a brand to the fake Facebook Page 111 / Instagram 999. */
export async function connectMeta(ctx, workspaceId) {
  const { encrypt } = await import('../src/security.js');
  await ctx.db.run(
    `INSERT INTO connections (workspace_id, platform, account_id, account_name, extra_id, extra_name, token, connected_by, created_at, updated_at)
     VALUES (?, 'meta', '111', 'Parcel.lk', '999', 'parcel.lk', ?, 'Sam', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    [workspaceId, encrypt('page-token', ctx.config.secretKey)]);
}

export function makePng(width, height) {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}

/** Connect a brand to the fake Canva account with template TPL1 and the usual field choices. */
export async function connectCanva(ctx, workspaceId, { expiresAt = Date.now() + 3600_000, shape = '16:9' } = {}) {
  const { encrypt } = await import('../src/security.js');
  ctx.state.canvaRefresh = 'refresh-0';
  const map = { capabilities: ['autofill'], shape, fields: { PHOTO: { type: 'image', use: 'photo' }, HEADLINE: { type: 'text', use: 'headline' }, CTA_BUTTON: { type: 'text', use: 'cta' }, SALES: { type: 'chart', use: 'none' } } };
  await ctx.db.run(
    `INSERT INTO connections (workspace_id, platform, account_id, account_name, extra_id, extra_name, token, data, connected_by, created_at, updated_at)
     VALUES (?, 'canva', 'CU1', 'GTV Designs', 'TPL1', 'FB offer post', ?, ?, 'Sam', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    [workspaceId, encrypt(JSON.stringify({ access: 'access-0', refresh: 'refresh-0', expiresAt }), ctx.config.secretKey), JSON.stringify(map)]);
}
