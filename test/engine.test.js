import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, addBrand } from './helpers.js';
import { hashPassword, verifyPassword, encrypt, decrypt } from '../src/security.js';
import { localToUtc, MAX_VERSIONS } from '../src/util.js';
import { verifySlackSignature } from '../src/services/slack.js';
import { slackSign } from './helpers.js';

const brief = { goal: 'Free pickup in December', details: 'UK parcels', language: 'English' };

async function newPost(ctx, over = {}) {
  const ws = over.ws ?? await addBrand(ctx.db, over.brand);
  const id = await ctx.app.engine.createPost({ workspaceId: ws, actor: 'Sam', brief, platforms: ['instagram', 'x'], publishAt: null });
  return id;
}

test('passwords and stored secrets round-trip', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  const enc = encrypt('sk-ant-secret', 'k');
  assert.notEqual(enc, 'sk-ant-secret');
  assert.equal(decrypt(enc, 'k'), 'sk-ant-secret');
  assert.throws(() => decrypt(enc, 'other-key'));
});

test('Colombo local time converts to UTC', () => {
  assert.equal(localToUtc('2026-11-20T18:30', 'Asia/Colombo'), '2026-11-20 13:00:00');
  assert.equal(localToUtc('garbage', 'Asia/Colombo'), null);
});

test('brief is written by Claude and lands in review', async () => {
  const ctx = await makeApp();
  await ctx.app.settings.set('anthropic_api_key', 'sk-ant-test');
  const id = await newPost(ctx);
  assert.equal((await ctx.app.engine.getPost(id)).status, 'generating');
  assert.equal(await ctx.app.engine.drain(), 1);
  const post = await ctx.app.engine.getPost(id);
  assert.equal(post.status, 'in_review');
  assert.equal(post.version, 1);
  assert.equal(post.content.headline, 'Free pickup this December');
  assert.deepEqual(Object.keys(post.content.captions), ['instagram', 'x']);
  assert.deepEqual(post.content.hashtags, ['ParcelLK', 'shipping']); // leading # stripped
  const usage = await ctx.db.get('SELECT * FROM usage_log WHERE post_id = ?', [id]);
  assert.equal(usage.input_tokens, 120);
  // the key is stored encrypted, not in plain text
  const raw = await ctx.db.get(`SELECT svalue FROM settings WHERE skey = 'anthropic_api_key'`);
  assert.ok(!raw.svalue.includes('sk-ant-test'));
});

test('missing Claude key fails the post with a clear message, and retry works once the key is added', async () => {
  const ctx = await makeApp();
  const id = await newPost(ctx);
  await ctx.app.engine.drain();
  let post = await ctx.app.engine.getPost(id);
  assert.equal(post.status, 'failed');
  assert.match(post.error, /Claude API key is missing/);
  await ctx.app.settings.set('anthropic_api_key', 'sk-ant-test');
  await ctx.app.engine.retry(id, 'Sam');
  await ctx.app.engine.drain();
  post = await ctx.app.engine.getPost(id);
  assert.equal(post.status, 'in_review');
});

test('a temporary Claude outage is retried later instead of failing the post', async () => {
  const ctx = await makeApp();
  await ctx.app.settings.set('anthropic_api_key', 'sk-ant-test');
  const id = await newPost(ctx);
  ctx.state.claudeStatus = 529;
  await ctx.app.engine.drain();
  assert.equal((await ctx.app.engine.getPost(id)).status, 'generating');
  const job = await ctx.db.get('SELECT * FROM jobs WHERE post_id = ?', [id]);
  assert.equal(job.status, 'queued');
  assert.equal(job.attempts, 1);
  // make it due now and let Claude recover
  ctx.state.claudeStatus = 0;
  await ctx.db.run(`UPDATE jobs SET run_at = '2000-01-01 00:00:00' WHERE id = ?`, [job.id]);
  await ctx.app.engine.drain();
  assert.equal((await ctx.app.engine.getPost(id)).status, 'in_review');
});

test('a bad API key is not retried', async () => {
  const ctx = await makeApp();
  await ctx.app.settings.set('anthropic_api_key', 'sk-ant-bad');
  const id = await newPost(ctx);
  ctx.state.claudeStatus = 401;
  await ctx.app.engine.drain();
  assert.equal((await ctx.app.engine.getPost(id)).status, 'failed');
});

test('approve works once; a second decision is refused', async () => {
  const ctx = await makeApp();
  await ctx.app.settings.set('anthropic_api_key', 'sk-ant-test');
  const id = await newPost(ctx);
  await ctx.app.engine.drain();
  const post = await ctx.app.engine.approve(id, 'Sam');
  assert.equal(post.status, 'approved');
  assert.equal(post.decided_by, 'Sam');
  await assert.rejects(() => ctx.app.engine.reject(id, 'Other'), /no longer waiting/);
  await assert.rejects(() => ctx.app.engine.requestChanges(id, 'Other', 'x'), /no longer waiting/);
});

test('requested changes go back to Claude with the note and the previous version', async () => {
  const ctx = await makeApp();
  await ctx.app.settings.set('anthropic_api_key', 'sk-ant-test');
  const id = await newPost(ctx);
  await ctx.app.engine.drain();
  await assert.rejects(() => ctx.app.engine.requestChanges(id, 'Sam', '   '), /Say what should change/);
  await ctx.app.engine.requestChanges(id, 'Sam', 'Make the headline shorter');
  assert.equal((await ctx.app.engine.getPost(id)).status, 'generating');
  await ctx.app.engine.drain();
  const post = await ctx.app.engine.getPost(id);
  assert.equal(post.status, 'in_review');
  assert.equal(post.version, 2);
  assert.equal(post.content.headline, 'Shorter headline');
  const sent = ctx.state.calls.filter((c) => c.url.includes('anthropic')).at(-1).body.messages[0].content;
  assert.match(sent, /Make the headline shorter/);
  assert.match(sent, /Free pickup this December/);
});

test(`changes stop after ${MAX_VERSIONS - 1} rounds`, async () => {
  const ctx = await makeApp();
  await ctx.app.settings.set('anthropic_api_key', 'sk-ant-test');
  const id = await newPost(ctx);
  await ctx.app.engine.drain();
  for (let i = 1; i < MAX_VERSIONS; i++) {
    await ctx.app.engine.requestChanges(id, 'Sam', `round ${i}`);
    await ctx.app.engine.drain();
  }
  assert.equal((await ctx.app.engine.getPost(id)).version, MAX_VERSIONS);
  await assert.rejects(() => ctx.app.engine.requestChanges(id, 'Sam', 'one more'), /rounds of changes/);
  assert.equal((await ctx.app.engine.getPost(id)).status, 'in_review');
});

test('review goes to the brand Slack channel, and the message is updated on approval', async () => {
  const ctx = await makeApp();
  await ctx.app.settings.set('anthropic_api_key', 'sk-ant-test');
  await ctx.app.settings.set('slack_bot_token', 'xoxb-test');
  const id = await newPost(ctx, { brand: { slack_channel: 'C0123ABCD' } });
  await ctx.app.engine.drain();
  const post = await ctx.app.engine.getPost(id);
  assert.equal(post.slack_ts, '111.222');
  const msg = ctx.state.calls.find((c) => c.url.includes('chat.postMessage')).body;
  assert.equal(msg.channel, 'C0123ABCD');
  assert.deepEqual(msg.blocks.at(-1).elements.map((e) => e.action_id), ['approve', 'changes', 'reject']);
  await ctx.app.engine.approve(id, 'Sam');
  const upd = ctx.state.calls.find((c) => c.url.includes('chat.update')).body;
  assert.equal(upd.ts, '111.222');
  assert.ok(!upd.blocks.some((b) => b.type === 'actions'), 'buttons are removed after the decision');
});

test('a Slack failure does not block review in the dashboard', async () => {
  const ctx = await makeApp();
  await ctx.app.settings.set('anthropic_api_key', 'sk-ant-test');
  await ctx.app.settings.set('slack_bot_token', 'xoxb-test');
  ctx.state.slackFail = true;
  const id = await newPost(ctx, { brand: { slack_channel: 'C0123ABCD' } });
  await ctx.app.engine.drain();
  assert.equal((await ctx.app.engine.getPost(id)).status, 'in_review');
  const ev = await ctx.db.get(`SELECT * FROM post_events WHERE post_id = ? AND kind = 'slack_failed'`, [id]);
  assert.match(ev.note, /channel_not_found/);
});

test('a job left running by a restart is picked up again', async () => {
  const ctx = await makeApp();
  await ctx.app.settings.set('anthropic_api_key', 'sk-ant-test');
  const id = await newPost(ctx);
  await ctx.db.run(`UPDATE jobs SET status = 'running', attempts = 1, locked_at = '2000-01-01 00:00:00' WHERE post_id = ?`, [id]);
  await ctx.app.engine.drain();
  assert.equal((await ctx.app.engine.getPost(id)).status, 'in_review');
});

test('Slack signatures: valid, tampered and stale', () => {
  const body = 'payload=%7B%7D';
  const h = slackSign('secret', body);
  const base = { signingSecret: 'secret', timestamp: h['x-slack-request-timestamp'], signature: h['x-slack-signature'], rawBody: body };
  assert.equal(verifySlackSignature(base), true);
  assert.equal(verifySlackSignature({ ...base, rawBody: body + 'x' }), false);
  assert.equal(verifySlackSignature({ ...base, signingSecret: 'other' }), false);
  const old = slackSign('secret', body, Math.floor(Date.now() / 1000) - 3600);
  assert.equal(verifySlackSignature({ ...base, timestamp: old['x-slack-request-timestamp'], signature: old['x-slack-signature'] }), false);
  assert.equal(verifySlackSignature({ ...base, signingSecret: '' }), false);
});

test('a post written as JSON text instead of a tool call is still accepted', async () => {
  const { generateContent } = await import('../src/services/claude.js');
  const fetchImpl = async (url, init) => {
    assert.equal(JSON.parse(init.body).tool_choice.type, 'auto');
    return { ok: true, status: 200, json: async () => ({ model: 'm', usage: {}, content: [{ type: 'text', text: 'Here it is:\n{"headline":"H","image_prompt":"I","captions":{"x":"C"},"hashtags":["a"],"cta":"Go"}' }] }) };
  };
  const r = await generateContent({ apiKey: 'k', workspace: { name: 'B' }, brief: { goal: 'g' }, platforms: ['x'], fetchImpl });
  assert.equal(r.content.captions.x, 'C');
});
