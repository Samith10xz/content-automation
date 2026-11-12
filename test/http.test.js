import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, serve, csrfOf, slackSign, addBrand, makeJpeg } from './helpers.js';

async function signedIn() {
  const ctx = await makeApp();
  const web = await serve(ctx.app);
  const r = await web.post('/setup', { token: 'setup-token', name: 'Sam', email: 'sam@example.com', password: 'a-long-password' });
  assert.equal(r.status, 303);
  const home = await web.get('/');
  return { ...ctx, web, csrf: csrfOf(home.text) };
}

test('pages need a sign-in; health is public', async () => {
  const ctx = await makeApp();
  const web = await serve(ctx.app);
  try {
    for (const p of ['/', '/brands', '/settings', '/posts/1', '/posts/new']) {
      const r = await web.get(p);
      assert.equal(r.status, 303, p); assert.equal(r.location, '/login');
    }
    const health = await web.get('/health');
    assert.deepEqual(JSON.parse(health.text), { ok: true, db: true, version: '0.1.0' });
    assert.equal((await web.get('/nope')).status, 404);
  } finally { await web.close(); }
});

test('setup needs the token, runs once, then sign-in works', async () => {
  const ctx = await makeApp();
  const web = await serve(ctx.app);
  try {
    assert.equal((await web.get('/setup')).status, 403);
    assert.equal((await web.get('/setup?token=wrong')).status, 403);
    assert.equal((await web.post('/setup', { token: 'wrong', name: 'X', email: 'x@example.com', password: 'a-long-password' })).status, 403);
    assert.match((await web.get('/setup?token=setup-token')).text, /Create the owner account/);
    assert.match((await web.post('/setup', { token: 'setup-token', name: 'Sam', email: 'sam@example.com', password: 'short' })).text, /at least 10 characters/);
    assert.equal((await web.post('/setup', { token: 'setup-token', name: 'Sam', email: 'Sam@Example.com', password: 'a-long-password' })).status, 303);
    // second owner cannot be created with the same link
    const again = await web.get('/setup?token=setup-token');
    assert.equal(again.status, 303); assert.equal(again.location, '/login');
    assert.equal((await web.post('/setup', { token: 'setup-token', name: 'Eve', email: 'eve@example.com', password: 'a-long-password' })).location, '/login');
    assert.equal(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM users')).n), 1);

    const home = await web.get('/');
    await web.post('/logout', { _csrf: csrfOf(home.text) });
    assert.equal((await web.get('/')).location, '/login');
    assert.equal((await web.post('/login', { email: 'sam@example.com', password: 'nope-nope-nope' })).status, 401);
    assert.equal((await web.post('/login', { email: 'sam@example.com', password: 'a-long-password' })).status, 303);
    assert.equal((await web.get('/')).status, 200);
  } finally { await web.close(); }
});

test('forms without the CSRF token are refused', async () => {
  const s = await signedIn();
  try {
    const r = await s.web.post('/brands', { name: 'Evil', primary_color: '#000000', secondary_color: '#ffffff', timezone: 'Asia/Colombo' });
    assert.equal(r.status, 403);
    assert.equal(Number((await s.db.get('SELECT COUNT(*) AS n FROM workspaces')).n), 0);
  } finally { await s.web.close(); }
});

test('brand, brief, review and approval through the pages', async () => {
  const s = await signedIn();
  try {
    assert.match((await s.web.get('/')).text, /Add your first brand/);
    const bad = await s.web.post('/brands', { _csrf: s.csrf, name: 'Parcel.LK', primary_color: 'red', secondary_color: '#ffffff', timezone: 'Asia/Colombo' });
    assert.match(bad.text, /Pick both brand colours/);
    const badCh = await s.web.post('/brands', { _csrf: s.csrf, name: 'Parcel.LK', primary_color: '#2f43b8', secondary_color: '#ffffff', timezone: 'Asia/Colombo', slack_channel: '#approvals' });
    assert.match(badCh.text, /channel ID looks like/);
    assert.equal((await s.web.post('/brands', { _csrf: s.csrf, name: 'Parcel.LK <b>', primary_color: '#2f43b8', secondary_color: '#f5b700', timezone: 'Asia/Colombo', tone: 'Warm' })).status, 303);
    const brands = await s.web.get('/brands');
    assert.match(brands.text, /Parcel\.LK &lt;b&gt;/); // user text is escaped
    assert.ok(!brands.text.includes('Parcel.LK <b>'));

    assert.match((await s.web.get('/')).text, /Claude is not connected yet/);
    await s.web.post('/settings/claude', { _csrf: s.csrf, anthropic_api_key: 'sk-ant-test', claude_model: 'claude-sonnet-5-5' });
    const settings = await s.web.get('/settings');
    assert.ok(!settings.text.includes('sk-ant-test'), 'saved key is never shown again');
    assert.match((await s.web.post('/settings/claude/test', { _csrf: s.csrf, claude_model: 'claude-sonnet-5-5' })).location, /Claude%20is%20connected/);

    const noPlatform = await s.web.post('/posts', { _csrf: s.csrf, brand: '1', goal: 'Free pickup' });
    assert.match(noPlatform.text, /at least one platform/);
    const past = await s.web.post('/posts', `_csrf=${s.csrf}&brand=1&goal=Free+pickup&platforms=x&publish_at=2020-01-01T10:00`);
    assert.match(past.text, /in the past/);
    const created = await s.web.post('/posts', `_csrf=${s.csrf}&brand=1&goal=Free+pickup+in+December&details=UK&platforms=instagram&platforms=x&language=English`);
    assert.equal(created.location, '/posts/1');
    const writing = await s.web.get('/posts/1');
    assert.match(writing.text, /Claude is writing this post/);
    assert.match(writing.text, /http-equiv="refresh"/);

    await s.app.engine.drain();
    const review = await s.web.get('/posts/1');
    assert.match(review.text, /Free pickup this December/);
    assert.match(review.text, /Caption for instagram/);
    assert.match(review.text, /Request changes/);
    assert.ok(!review.text.includes('http-equiv="refresh"'));

    assert.match((await s.web.post('/posts/1/changes', { _csrf: s.csrf, note: 'Shorter' })).location, /Changes%20requested/);
    await s.app.engine.drain();
    assert.match((await s.web.get('/posts/1')).text, /version 2/);
    // Instagram needs an image before approval
    assert.match((await s.web.post('/posts/1/approve', { _csrf: s.csrf })).location, /err=Instagram%20needs%20an%20image/);
    const up = await s.web.raw('POST', '/posts/1/image', makeJpeg(1080, 1080), { 'content-type': 'image/jpeg', 'x-csrf-token': s.csrf });
    assert.equal(up.status, 200, up.text);
    const page = await s.web.get('/posts/1');
    const src = /<img class="post-image" src="http:\/\/localhost(\/media\/[a-f0-9]{48}\.jpg)"/.exec(page.text);
    assert.ok(src, 'image shown on the post page');
    assert.match((await s.web.post('/posts/1/approve', { _csrf: s.csrf })).location, /msg=Post%20approved/);
    const done = await s.web.get('/posts/1');
    assert.match(done.text, /Publishing now/);
    assert.match((await s.web.post('/posts/1/approve', { _csrf: s.csrf })).location, /err=.*no%20longer%20waiting/);
    assert.match((await s.web.get('/?status=publishing')).text, /Shorter headline/);
    assert.equal((await s.web.get('/posts/999')).status, 404);
  } finally { await s.web.close(); }
});

test('Slack buttons: signed approve works, unsigned is refused, changes opens the note box', async () => {
  const s = await signedIn();
  try {
    await s.app.settings.set('anthropic_api_key', 'sk-ant-test');
    await s.app.settings.set('slack_bot_token', 'xoxb-test');
    await s.app.settings.set('slack_signing_secret', 'sign-secret');
    const ws = await addBrand(s.db, { slack_channel: 'C0123ABCD' });
    const mk = async () => { const id = await s.app.engine.createPost({ workspaceId: ws, actor: 'Sam', brief: { goal: 'g' }, platforms: ['x'], publishAt: null }); await s.app.engine.drain(); return id; };
    const send = (payload, secret = 'sign-secret') => {
      const raw = 'payload=' + encodeURIComponent(JSON.stringify(payload));
      return s.web.post('/api/slack/interactions', raw, slackSign(secret, raw));
    };
    const a = await mk();
    const user = { name: 'nimal' };
    assert.equal((await send({ type: 'block_actions', user, actions: [{ action_id: 'approve', value: String(a) }] }, 'wrong-secret')).status, 401);
    assert.equal((await s.app.engine.getPost(a)).status, 'in_review');
    assert.equal((await send({ type: 'block_actions', user, actions: [{ action_id: 'approve', value: String(a) }] })).status, 200);
    await new Promise((r) => setTimeout(r, 50)); // the work finishes just after Slack gets its answer
    const post = await s.app.engine.getPost(a);
    assert.equal(post.status, 'publishing'); assert.equal(post.decided_by, 'nimal (Slack)');

    const b = await mk();
    await send({ type: 'block_actions', user, trigger_id: 'trig', actions: [{ action_id: 'changes', value: String(b) }] });
    await new Promise((r) => setTimeout(r, 50));
    const modal = s.state.calls.find((c) => c.url.includes('views.open')).body;
    assert.equal(modal.view.private_metadata, String(b));
    const view = (note) => ({ type: 'view_submission', user, view: { callback_id: 'changes_modal', private_metadata: String(b), state: { values: { note: { value: { value: note } } } } } });
    assert.match((await send(view('  '))).text, /Say what should change/);
    assert.equal((await send(view('Add the deadline'))).text, '');
    assert.equal((await s.app.engine.getPost(b)).status, 'generating');

    const c = await mk();
    await send({ type: 'block_actions', user, actions: [{ action_id: 'reject', value: String(c) }] });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await s.app.engine.getPost(c)).status, 'rejected');
  } finally { await s.web.close(); }
});

test('cron tick needs its key and runs waiting work', async () => {
  const s = await signedIn();
  try {
    await s.app.settings.set('anthropic_api_key', 'sk-ant-test');
    const ws = await addBrand(s.db);
    const id = await s.app.engine.createPost({ workspaceId: ws, actor: 'Sam', brief: { goal: 'g' }, platforms: ['x'], publishAt: null });
    assert.equal((await s.web.get('/api/cron/tick')).status, 403);
    assert.equal((await s.web.get('/api/cron/tick?key=nope')).status, 403);
    const r = await s.web.get('/api/cron/tick?key=cron-secret');
    assert.deepEqual(JSON.parse(r.text), { ok: true, ran: 1 });
    assert.equal((await s.app.engine.getPost(id)).status, 'in_review');
    assert.match((await s.web.get('/settings')).text, /last ran/);
  } finally { await s.web.close(); }
});
