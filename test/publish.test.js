import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, addBrand, makeJpeg, connectMeta, serve, csrfOf } from './helpers.js';
import { jpegInfo, instagramProblem } from '../src/media.js';

const brief = { goal: 'Free pickup', details: 'UK', language: 'English' };

async function readyPost(ctx, { platforms = ['facebook', 'instagram'], image = [1080, 1350], connect = true, slack = false, publishAt = null } = {}) {
  await ctx.app.settings.set('anthropic_api_key', 'sk-ant-test');
  if (slack) await ctx.app.settings.set('slack_bot_token', 'xoxb-test');
  const ws = await addBrand(ctx.db, slack ? { slack_channel: 'C0123ABCD' } : {});
  if (connect) await connectMeta(ctx, ws);
  const id = await ctx.app.engine.createPost({ workspaceId: ws, actor: 'Sam', brief, platforms, publishAt });
  if (image) await ctx.app.engine.setImage(id, makeJpeg(...image), 'Sam');
  await ctx.app.engine.drain();
  return id;
}

test('JPEG size is read; PNG and junk are refused; Instagram shape is checked', async () => {
  assert.deepEqual(jpegInfo(makeJpeg(1080, 1350)), { width: 1080, height: 1350 });
  assert.equal(jpegInfo(Buffer.from('hello world, not an image')), null);
  assert.equal(instagramProblem({ width: 1080, height: 1080 }), '');
  assert.equal(instagramProblem({ width: 1080, height: 1350 }), '');
  assert.match(instagramProblem({ width: 1080, height: 1920 }), /4:5/); // a story-shaped image
  assert.match(instagramProblem(null), /needs an image/);

  const ctx = await makeApp();
  const id = await readyPost(ctx, { image: null });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  await assert.rejects(() => ctx.app.engine.setImage(id, png, 'Sam'), /PNG/);
  await assert.rejects(() => ctx.app.engine.setImage(id, Buffer.from('nope nope nope'), 'Sam'), /not a JPG/);
  await assert.rejects(() => ctx.app.engine.approve(id, 'Sam'), /needs an image/);
  await ctx.app.engine.setImage(id, makeJpeg(1080, 1920), 'Sam');
  await assert.rejects(() => ctx.app.engine.approve(id, 'Sam'), /4:5/);
  await ctx.app.engine.setImage(id, makeJpeg(1080, 1080), 'Sam');
  assert.equal(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM media')).n), 1, 'replaced images are deleted');
  await ctx.app.engine.approve(id, 'Sam');
});

test('approval publishes to the Facebook Page and Instagram, with links', async () => {
  const ctx = await makeApp();
  const id = await readyPost(ctx, { platforms: ['facebook', 'instagram', 'x'], slack: true });
  const post = await ctx.app.engine.approve(id, 'Sam');
  assert.equal(post.status, 'publishing');
  await ctx.app.engine.drain();
  const done = await ctx.app.engine.getPost(id);
  assert.equal(done.status, 'published');
  const results = await ctx.app.engine.publishResults(id);
  const by = Object.fromEntries(results.map((r) => [r.platform, r]));
  assert.equal(by.facebook.status, 'published');
  assert.equal(by.facebook.url, 'https://www.facebook.com/111_555');
  assert.equal(by.instagram.status, 'published');
  assert.equal(by.instagram.url, 'https://www.instagram.com/p/abc123/');
  assert.equal(by.x.status, 'skipped');

  // What was sent to Meta
  const fb = ctx.state.graph.find((g) => g.path === '111/photos').form;
  assert.equal(fb.access_token, 'page-token');
  assert.match(fb.url, /^http:\/\/localhost\/media\/[a-f0-9]{48}\.jpg$/);
  assert.match(fb.caption, /Caption for facebook/);
  assert.match(fb.caption, /#ParcelLK/);
  const ig = ctx.state.graph.find((g) => g.path === '999/media').form;
  assert.equal(ig.image_url, fb.url);
  assert.match(ig.caption, /Caption for instagram/);
  assert.equal(ctx.state.graph.find((g) => g.path === '999/media_publish').form.creation_id, 'container1');

  // Slack: message marked, then a thread reply with the links
  const thread = ctx.state.calls.filter((c) => c.url.includes('chat.postMessage') && c.body.thread_ts).at(-1).body;
  assert.equal(thread.thread_ts, '111.222');
  assert.match(thread.text, /facebook\.com\/111_555/);
  assert.match(thread.text, /instagram\.com\/p\/abc123/);
  assert.match(thread.text, /X: Publishing to X is not connected yet/);
});

test('Facebook only, without an image, posts text', async () => {
  const ctx = await makeApp();
  const id = await readyPost(ctx, { platforms: ['facebook'], image: null });
  await ctx.app.engine.approve(id, 'Sam');
  await ctx.app.engine.drain();
  assert.equal((await ctx.app.engine.getPost(id)).status, 'published');
  assert.ok(ctx.state.graph.some((g) => g.path === '111/feed'));
});

test('a brand that is not connected fails clearly, and retry works after connecting', async () => {
  const ctx = await makeApp();
  const id = await readyPost(ctx, { connect: false });
  await ctx.app.engine.approve(id, 'Sam');
  await ctx.app.engine.drain();
  assert.equal((await ctx.app.engine.getPost(id)).status, 'publish_failed');
  const r = await ctx.app.engine.publishResults(id);
  assert.match(r[0].error, /not connected to Facebook yet/);
  assert.equal(ctx.state.graph.length, 0);

  await connectMeta(ctx, (await ctx.app.engine.getPost(id)).workspace_id);
  await ctx.app.engine.retryPublish(id, 'Sam');
  await ctx.app.engine.drain();
  assert.equal((await ctx.app.engine.getPost(id)).status, 'published');
  await assert.rejects(() => ctx.app.engine.retryPublish(id, 'Sam'), /Only posts that failed/);
});

test('an expired Facebook token fails only that post, with a reconnect message', async () => {
  const ctx = await makeApp();
  const id = await readyPost(ctx, { platforms: ['facebook'] });
  ctx.state.metaFail['111/photos'] = { status: 400, error: { message: 'Session expired', code: 190 } };
  await ctx.app.engine.approve(id, 'Sam');
  await ctx.app.engine.drain();
  const [r] = await ctx.app.engine.publishResults(id);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /Reconnect the brand/);
});

test('a temporary Meta error is retried; Instagram resumes the same upload', async () => {
  const ctx = await makeApp();
  const id = await readyPost(ctx, { platforms: ['instagram'] });
  ctx.state.igStatus = ['IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS']; // still processing after the polls
  await ctx.app.engine.approve(id, 'Sam');
  await ctx.app.engine.drain();
  assert.equal((await ctx.app.engine.getPost(id)).status, 'publishing');
  const [r] = await ctx.app.engine.publishResults(id);
  assert.equal(r.status, 'pending');
  assert.equal(r.container_id, 'container1');
  // next attempt: Instagram finished; no second container is created
  await ctx.db.run(`UPDATE jobs SET run_at = '2000-01-01 00:00:00' WHERE kind = 'publish'`);
  await ctx.app.engine.drain();
  assert.equal((await ctx.app.engine.getPost(id)).status, 'published');
  assert.equal(ctx.state.graph.filter((g) => g.path === '999/media').length, 1);
});

test('a post with a future publish time waits for it', async () => {
  const ctx = await makeApp();
  const id = await readyPost(ctx, { platforms: ['facebook'], publishAt: '2099-01-01 10:00:00' });
  const post = await ctx.app.engine.approve(id, 'Sam');
  assert.equal(post.status, 'scheduled');
  await ctx.app.engine.drain();
  assert.equal((await ctx.app.engine.getPost(id)).status, 'scheduled');
  assert.equal(ctx.state.graph.length, 0);
  await ctx.db.run(`UPDATE jobs SET run_at = '2000-01-01 00:00:00' WHERE kind = 'publish'`);
  await ctx.app.engine.drain();
  assert.equal((await ctx.app.engine.getPost(id)).status, 'published');
});

test('Facebook connection: login, pick the Page, token stored encrypted; images are served', async () => {
  const ctx = await makeApp();
  const web = await serve(ctx.app);
  try {
    await web.post('/setup', { token: 'setup-token', name: 'Sam', email: 'sam@example.com', password: 'a-long-password' });
    const csrf = csrfOf((await web.get('/')).text);
    const ws = await addBrand(ctx.db);
    assert.match((await web.get(`/brands/${ws}/connect/meta`)).location, /err=Add%20the%20Meta%20app/);
    assert.match((await web.post('/settings/meta', { _csrf: csrf, meta_app_id: 'abc' })).location, /err=/);
    await web.post('/settings/meta', { _csrf: csrf, meta_app_id: '1234567890', meta_app_secret: 'app-secret' });
    assert.match((await web.get(`/brands/${ws}`)).text, /Connect Facebook and Instagram/);

    const go = await web.get(`/brands/${ws}/connect/meta`);
    const auth = new URL(go.location);
    assert.equal(auth.host, 'www.facebook.com');
    assert.equal(auth.searchParams.get('client_id'), '1234567890');
    assert.equal(auth.searchParams.get('redirect_uri'), 'http://localhost/api/oauth/meta/callback');
    assert.match(auth.searchParams.get('scope'), /instagram_content_publish/);
    const state = auth.searchParams.get('state');

    // a forged state is refused
    assert.match((await web.get('/api/oauth/meta/callback?state=' + 'f'.repeat(48) + '&code=x')).location, /expired/);
    const cb = await web.get(`/api/oauth/meta/callback?state=${state}&code=the-code`);
    assert.equal(cb.location, `/brands/${ws}/connect/meta/pick?state=${state}`);
    const ex = ctx.state.graph.find((g) => g.path === 'oauth/access_token' && g.form.code);
    assert.equal(ex.form.client_secret, 'app-secret');
    const pick = await web.get(cb.location);
    assert.match(pick.text, /Instagram @parcel\.lk/);
    assert.ok(!pick.text.includes('page-token'), 'page tokens never reach the browser');

    const saved = await web.post(`/brands/${ws}/connect/meta/pick`, { _csrf: csrf, state, page_id: '111' });
    assert.match(saved.location, /Connected%20to%20the%20Parcel\.lk%20Facebook%20Page%20and%20Instagram%20%40parcel\.lk/);
    const row = await ctx.db.get('SELECT * FROM connections WHERE workspace_id = ?', [ws]);
    assert.equal(row.extra_id, '999');
    assert.ok(!row.token.includes('page-token'), 'token is encrypted at rest');
    // the state is single-use
    assert.match((await web.post(`/brands/${ws}/connect/meta/pick`, { _csrf: csrf, state, page_id: '111' })).location, /expired/);

    // media: real token serves bytes, others 404
    const id = await ctx.app.engine.createPost({ workspaceId: ws, actor: 'Sam', brief, platforms: ['facebook'], publishAt: null });
    const post = await ctx.app.engine.setImage(id, makeJpeg(1080, 1080), 'Sam');
    const img = await fetch(`${web.base}/media/${post.image.token}.jpg`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal((await fetch(`${web.base}/media/${'0'.repeat(48)}.jpg`)).status, 404);
    assert.equal((await fetch(`${web.base}/media/..%2F..%2Fetc.jpg`)).status, 404);

    // signed-out uploads and uploads without the page token are refused
    assert.equal((await web.raw('POST', `/posts/${id}/image`, makeJpeg(10, 10), { 'content-type': 'image/jpeg', 'x-csrf-token': 'wrong' })).status, 403);
    assert.equal((await web.get('/privacy')).status, 200);
    assert.equal((await web.get('/data-deletion')).status, 200);

    await web.post(`/brands/${ws}/disconnect/meta`, { _csrf: csrf });
    assert.equal(await ctx.db.get('SELECT * FROM connections WHERE workspace_id = ?', [ws]), undefined);
  } finally { await web.close(); }
});
