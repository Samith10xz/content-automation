import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, addBrand, makeJpeg, makePng, connectMeta, serve, csrfOf, slackSign } from './helpers.js';

const brief = { goal: 'Free pickup in December', details: 'UK parcels', language: 'English' };
const geminiCalls = (ctx) => ctx.state.calls.filter((c) => c.url.includes('/interactions'));

async function setup({ gemini = true, slack = false, brand = {} } = {}) {
  const ctx = await makeApp();
  await ctx.app.settings.set('anthropic_api_key', 'sk-ant-test');
  if (gemini) await ctx.app.settings.set('gemini_api_key', 'g-key');
  if (slack) { await ctx.app.settings.set('slack_bot_token', 'xoxb-test'); await ctx.app.settings.set('slack_signing_secret', 'sign-secret'); }
  ctx.ws = await addBrand(ctx.db, brand);
  ctx.newPost = async (platforms = ['facebook', 'instagram']) => {
    const id = await ctx.app.engine.createPost({ workspaceId: ctx.ws, actor: 'Sam', brief, platforms, publishAt: null });
    await ctx.app.engine.drain();
    return id;
  };
  return ctx;
}

test('a brief gets its image from Gemini, with the headline and brand colours, as a 4:5 JPG', async () => {
  const ctx = await setup({ slack: true, brand: { slack_channel: 'C0123ABCD' } });
  const id = await ctx.newPost();
  const post = await ctx.app.engine.getPost(id);
  assert.equal(post.status, 'in_review');
  assert.equal(post.image.source, 'gemini');
  assert.equal(post.image.mime, 'image/jpeg');
  assert.equal(post.image.height, 1120); // the real output, not the "thought" draft
  const [call] = geminiCalls(ctx);
  assert.deepEqual(call.body.response_format, { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '4:5', image_size: '1K' });
  assert.equal(call.body.model, 'gemini-nano-banana-2.1');
  assert.match(call.body.input[0].text, /"Free pickup this December"/);
  assert.match(call.body.input[0].text, /#2f43b8/);
  assert.match(call.body.input[0].text, /Do not add any logo/);
  assert.equal(call.body.input.length, 1);
  // the Slack review message shows the image
  const msg = ctx.state.calls.find((c) => c.url.includes('chat.postMessage')).body;
  assert.equal(msg.blocks.find((b) => b.type === 'image').image_url, post.image.url);
  // and it can be approved straight away (Instagram has its image)
  await ctx.app.engine.approve(id, 'Sam');
});

test('the brand logo is sent to Gemini as a reference', async () => {
  const ctx = await setup();
  await ctx.app.engine.setLogo(ctx.ws, makePng(400, 200));
  await assert.rejects(() => ctx.app.engine.setLogo(ctx.ws, Buffer.from('not an image at all')), /PNG or JPG/);
  await ctx.newPost();
  const [call] = geminiCalls(ctx);
  assert.equal(call.body.input.length, 2);
  assert.equal(call.body.input[1].mime_type, 'image/png');
  assert.match(call.body.input[0].text, /attached brand logo/);
});

test('feedback about the picture edits the image; feedback about text leaves it alone', async () => {
  const ctx = await setup();
  const id = await ctx.newPost();
  const first = (await ctx.app.engine.getPost(id)).image;

  await ctx.app.engine.requestChanges(id, 'Sam', 'Make the image background lighter');
  await ctx.app.engine.drain();
  const second = (await ctx.app.engine.getPost(id)).image;
  assert.notEqual(second.id, first.id);
  const edit = geminiCalls(ctx).at(-1).body;
  assert.match(edit.input[0].text, /Edit the attached/);
  assert.match(edit.input[0].text, /background lighter/);
  assert.equal(edit.input[1].type, 'image'); // the previous version is the starting point
  assert.equal(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM media WHERE post_id = ?', [id])).n), 1, 'old versions are deleted');

  // fake Claude keeps the headline on later revisions and this note has nothing about the picture
  const before = geminiCalls(ctx).length;
  await ctx.app.engine.requestChanges(id, 'Sam', 'Shorten the LinkedIn caption');
  await ctx.app.engine.drain();
  assert.equal(geminiCalls(ctx).length, before);
  assert.equal((await ctx.app.engine.getPost(id)).image.id, second.id);
});

test('a hand-uploaded design is never overwritten by feedback', async () => {
  const ctx = await setup();
  const id = await ctx.newPost();
  await ctx.app.engine.setImage(id, makeJpeg(1080, 1350), 'Sam');
  const uploaded = (await ctx.app.engine.getPost(id)).image;
  const before = geminiCalls(ctx).length;
  await ctx.app.engine.requestChanges(id, 'Sam', 'Change the image to show a van');
  await ctx.app.engine.drain();
  const post = await ctx.app.engine.getPost(id);
  assert.equal(post.image.id, uploaded.id);
  assert.equal(geminiCalls(ctx).length, before);
  assert.ok(await ctx.db.get(`SELECT id FROM post_events WHERE post_id = ? AND kind = 'image_kept'`, [id]));
});

test('if Gemini fails the post still reaches review, says why, and the image can be generated later', async () => {
  const ctx = await setup();
  ctx.state.geminiStatus = 429;
  const id = await ctx.newPost();
  let post = await ctx.app.engine.getPost(id);
  assert.equal(post.status, 'in_review');
  assert.equal(post.image, null);
  const ev = await ctx.db.get(`SELECT note FROM post_events WHERE post_id = ? AND kind = 'image_failed'`, [id]);
  assert.match(ev.note, /usage limit/);
  await assert.rejects(() => ctx.app.engine.approve(id, 'Sam'), /needs an image/);
  await assert.rejects(() => ctx.app.engine.generateImageNow(id, 'Sam'), /usage limit/);
  ctx.state.geminiStatus = 0;
  await ctx.app.engine.generateImageNow(id, 'Sam');
  post = await ctx.app.engine.getPost(id);
  assert.equal(post.image.source, 'gemini');
  // with a note and an existing Gemini image, the button edits it
  await ctx.app.engine.generateImageNow(id, 'Sam', 'Bigger headline');
  assert.match(geminiCalls(ctx).at(-1).body.input[0].text, /Bigger headline/);
});

test('without a Gemini key nothing is generated and nothing breaks', async () => {
  const ctx = await setup({ gemini: false });
  const id = await ctx.newPost(['facebook']);
  assert.equal((await ctx.app.engine.getPost(id)).status, 'in_review');
  assert.equal(geminiCalls(ctx).length, 0);
  await assert.rejects(() => ctx.app.engine.generateImageNow(id, 'Sam'), /Gemini API key/);
});

test('Slack request channel: a message becomes a post, is approved, published, and the requester is told', async () => {
  const ctx = await setup({ slack: true, brand: { slack_channel: 'C0APPROVE1' } });
  await ctx.db.run('UPDATE workspaces SET slack_request_channel = ? WHERE id = ?', ['C0REQUEST1', ctx.ws]);
  await connectMeta(ctx, ctx.ws);
  const web = await serve(ctx.app);
  const send = (body, secret = 'sign-secret') => {
    const raw = JSON.stringify(body);
    return web.raw('POST', '/api/slack/events', raw, { ...slackSign(secret, raw), 'content-type': 'application/json' });
  };
  const message = (over = {}) => ({ type: 'event_callback', event_id: 'Ev1', event: { type: 'message', channel: 'C0REQUEST1', user: 'U1', ts: '1700000000.000100', text: 'Post about &lt;free pickup&gt; for UK parcels in December <https://parcel.lk|our site> <@U999>', ...over } });
  const settle = () => new Promise((r) => setTimeout(r, 60));
  try {
    // Slack's setup handshake, and unsigned calls
    assert.deepEqual(JSON.parse((await send({ type: 'url_verification', challenge: 'abc123' })).text), { challenge: 'abc123' });
    assert.equal((await send(message(), 'wrong')).status, 401);
    await settle();
    assert.equal(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM posts')).n), 0);

    // ignored: bots, edits, thread replies, other channels, tiny messages
    for (const over of [{ bot_id: 'B1' }, { subtype: 'message_changed' }, { thread_ts: '1699999999.000001' }, { channel: 'C0OTHER123' }, { text: 'ok' }]) {
      assert.equal((await send(message(over))).status, 200);
    }
    await settle();
    assert.equal(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM posts')).n), 0);

    // the real request; Slack delivering it twice makes one post
    assert.equal((await send(message())).status, 200);
    await settle();
    await send(message());
    await settle();
    const rows = await ctx.db.all('SELECT * FROM posts');
    assert.equal(rows.length, 1);
    const id = rows[0].id;
    assert.equal(rows[0].source_ref, 'slack:C0REQUEST1:1700000000.000100');
    assert.equal(JSON.parse(rows[0].brief).goal, 'Post about <free pickup> for UK parcels in December our site (https://parcel.lk)');
    const threads = () => ctx.state.calls.filter((c) => c.url.includes('chat.postMessage') && c.body.channel === 'C0REQUEST1').map((c) => c.body);
    assert.equal(threads()[0].thread_ts, '1700000000.000100');
    assert.match(threads()[0].text, /Got it.*post and image.*<#C0APPROVE1>/);

    // written + designed, sent to the approval channel, requester told
    await ctx.app.engine.drain();
    const post = await ctx.app.engine.getPost(id);
    assert.equal(post.status, 'in_review');
    assert.equal(post.image.source, 'gemini');
    const review = ctx.state.calls.find((c) => c.url.includes('chat.postMessage') && c.body.channel === 'C0APPROVE1').body;
    assert.ok(review.blocks.some((b) => b.type === 'actions'));
    assert.match(threads()[1].text, /Version 1 is ready.*<#C0APPROVE1>/);

    // approved -> published to Meta -> links back in the request thread
    await ctx.app.engine.approve(id, 'nimal (Slack)');
    await ctx.app.engine.drain();
    assert.equal((await ctx.app.engine.getPost(id)).status, 'published');
    assert.match(threads().at(-1).text, /Published[\s\S]*facebook\.com\/111_555[\s\S]*instagram\.com\/p\/abc123/);
  } finally { await web.close(); }
});

test('settings and brand pages: Gemini key, request channel rules, logo upload, generate button', async () => {
  const ctx = await setup({ gemini: false });
  const web = await serve(ctx.app);
  try {
    await web.post('/setup', { token: 'setup-token', name: 'Sam', email: 'sam@example.com', password: 'a-long-password' });
    const csrf = csrfOf((await web.get('/')).text);
    assert.match((await web.post('/settings/gemini', { _csrf: csrf, gemini_api_key: 'g-secret-key', gemini_model: 'gemini-nano-banana-2.1', gemini_image_size: '9K' })).location, /err=Choose/);
    assert.match((await web.post('/settings/gemini/test', { _csrf: csrf, gemini_api_key: 'g-secret-key', gemini_model: 'gemini-nano-banana-2.1', gemini_image_size: '2K' })).location, /Gemini%20is%20connected/);
    const page = await web.get('/settings');
    assert.ok(!page.text.includes('g-secret-key'));
    assert.match(page.text, /api\/slack\/events/);
    assert.ok(!(await ctx.db.get(`SELECT svalue FROM settings WHERE skey = 'gemini_api_key'`)).svalue.includes('g-secret-key'));

    const base = { _csrf: csrf, name: 'Parcel.LK', primary_color: '#2f43b8', secondary_color: '#f5b700', timezone: 'Asia/Colombo' };
    assert.match((await web.post(`/brands/${ctx.ws}`, { ...base, slack_channel: 'C0SAME1234', slack_request_channel: 'C0SAME1234' })).text, /two different Slack channels/);
    assert.equal((await web.post(`/brands/${ctx.ws}`, { ...base, slack_channel: 'C0APPROVE1', slack_request_channel: 'C0REQUEST1' })).status, 303);
    const other = await addBrand(ctx.db, { name: 'LYAA' });
    assert.match((await web.post(`/brands/${other}`, { ...base, name: 'LYAA', slack_request_channel: 'C0REQUEST1' })).text, /already used by Parcel\.LK/);

    const up = await web.raw('POST', `/brands/${ctx.ws}/logo`, makePng(300, 120), { 'content-type': 'image/png', 'x-csrf-token': csrf });
    assert.equal(up.status, 200, up.text);
    const brandPage = await web.get(`/brands/${ctx.ws}`);
    const logo = /class="logo-preview" src="http:\/\/localhost(\/media\/[a-f0-9]{48}\.png)"/.exec(brandPage.text);
    assert.ok(logo);
    const img = await fetch(web.base + logo[1]);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await web.raw('POST', `/brands/${ctx.ws}/logo`, Buffer.from('zzzzzzzzzzzzzzzz'), { 'content-type': 'image/png', 'x-csrf-token': csrf })).status, 400);

    const id = await ctx.app.engine.createPost({ workspaceId: ctx.ws, actor: 'Sam', brief, platforms: ['facebook'], publishAt: null });
    await ctx.app.engine.drain();
    await ctx.app.engine.removeImage(id, 'Sam');
    assert.match((await web.get(`/posts/${id}`)).text, /Generate with Gemini/);
    assert.match((await web.post(`/posts/${id}/image/generate`, { _csrf: csrf, note: '' })).location, /msg=Image%20generated/);
    assert.match((await web.get(`/posts/${id}`)).text, /Made by Gemini/);
  } finally { await web.close(); }
});
