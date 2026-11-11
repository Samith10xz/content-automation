import http from 'node:http';
import crypto from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/** Fake Claude + Slack. `state` lets a test inspect calls and force failures. */
export function fakeFetch(state) {
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    state.calls.push({ url, body });
    const json = (status, data) => ({ ok: status < 400, status, json: async () => data });
    if (url.includes('api.anthropic.com')) {
      if (state.claudeStatus) return json(state.claudeStatus, { error: { message: 'boom' } });
      if (!body.tools) return json(200, { model: body.model, content: [{ type: 'text', text: 'OK' }] });
      const platforms = body.tools[0].input_schema.properties.captions.required;
      const revision = body.messages[0].content.includes('This is a revision');
      return json(200, {
        model: body.model, usage: { input_tokens: 120, output_tokens: 80 },
        content: [{ type: 'tool_use', name: 'save_post', input: {
          headline: revision ? 'Shorter headline' : 'Free pickup this December',
          image_prompt: 'A courier handing over a parcel',
          captions: Object.fromEntries(platforms.map((p) => [p, `Caption for ${p}${revision ? ' v2' : ''}`])),
          hashtags: ['#ParcelLK', 'shipping'], cta: 'Book now',
        } }],
      });
    }
    if (url.includes('slack.com/api/chat.postMessage')) return json(200, state.slackFail ? { ok: false, error: 'channel_not_found' } : { ok: true, channel: body.channel, ts: '111.222' });
    if (url.includes('slack.com/api/')) return json(200, { ok: true, team: 'GTV', user: 'pipeline' });
    return json(200, {});
  };
}

export async function makeApp(env = {}) {
  const state = { calls: [], claudeStatus: 0, slackFail: false };
  const config = loadConfig({ SECRET_KEY: 'a'.repeat(64), SETUP_TOKEN: 'setup-token', CRON_SECRET: 'cron-secret', APP_URL: 'http://localhost', ...env });
  const db = await openDb(config.db);
  const app = createApp({ db, config, fetchImpl: fakeFetch(state), log: { error() {} }, autoKick: false });
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
      body: form ? (typeof form === 'string' ? form : new URLSearchParams(form).toString()) : undefined,
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
