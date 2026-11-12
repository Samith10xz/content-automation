import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeApp, addBrand, connectCanva, connectMeta, serve, csrfOf } from './helpers.js';
import { guessUse, autofillData } from '../src/services/canva.js';

const brief = { goal: 'Free pickup in December', details: 'UK parcels', language: 'English' };
const gemini = (ctx) => ctx.state.calls.filter((c) => c.url.includes('/interactions')).map((c) => c.body);
const canvaCalls = (ctx, path, method = 'POST') => ctx.state.canva.filter((c) => c.path === path && c.method === method);

async function setup(opts = {}) {
  const ctx = await makeApp();
  await ctx.app.settings.set('anthropic_api_key', 'sk-ant-test');
  await ctx.app.settings.set('gemini_api_key', 'g-key');
  await ctx.app.settings.set('canva_client_id', 'OC-123456');
  await ctx.app.settings.set('canva_client_secret', 'canva-secret');
  ctx.ws = await addBrand(ctx.db);
  await connectCanva(ctx, ctx.ws, opts);
  ctx.newPost = async () => {
    const id = await ctx.app.engine.createPost({ workspaceId: ctx.ws, actor: 'Sam', brief, platforms: ['facebook', 'instagram'], publishAt: null });
    await ctx.app.engine.drain();
    return id;
  };
  return ctx;
}

test('field choices are guessed from the template field names', () => {
  const taken = new Set();
  const pick = (n, t) => { const u = guessUse(n, t, taken); if (u !== 'none') taken.add(u); return u; };
  assert.equal(pick('PHOTO', 'image'), 'photo');
  assert.equal(pick('LOGO', 'image'), 'none'); // only one image gets the generated photo
  assert.equal(pick('CTA_BUTTON', 'text'), 'cta');
  assert.equal(pick('HEADLINE', 'text'), 'headline');
  assert.equal(pick('SUBTITLE', 'text'), 'none');
  assert.equal(pick('SALES', 'chart'), 'none');
  assert.deepEqual(
    autofillData({ P: { type: 'image', use: 'photo' }, H: { type: 'text', use: 'headline' }, B: { type: 'text', use: 'brand' }, X: { type: 'text', use: 'none' } },
      { assetId: 'A1', content: { headline: 'Hi', cta: 'Go' }, brandName: 'Parcel.LK' }),
    { P: { type: 'image', asset_id: 'A1' }, H: { type: 'text', text: 'Hi' }, B: { type: 'text', text: 'Parcel.LK' } });
});

test('Gemini makes a text-free photo, Canva fills the template, and the export becomes the post image', async () => {
  const ctx = await setup();
  const id = await ctx.newPost();
  const post = await ctx.app.engine.getPost(id);
  assert.equal(post.status, 'in_review');
  // Gemini: photo only, in the template's photo shape, no logo reference
  const [g] = gemini(ctx);
  assert.match(g.input[0].text, /No text, letters, numbers, logos/);
  assert.ok(!g.input[0].text.includes('Free pickup this December'), 'the headline is left to the template');
  assert.equal(g.response_format.aspect_ratio, '16:9');
  // Canva: photo imported by URL, template filled, design exported
  const up = canvaCalls(ctx, '/url-asset-uploads')[0];
  assert.equal(up.body.url, post.photo.url);
  assert.equal(up.auth, 'Bearer access-0');
  const fill = canvaCalls(ctx, '/autofills')[0].body;
  assert.equal(fill.brand_template_id, 'TPL1');
  assert.deepEqual(fill.data, {
    PHOTO: { type: 'image', asset_id: 'ASSET1' },
    HEADLINE: { type: 'text', text: 'Free pickup this December' },
    CTA_BUTTON: { type: 'text', text: 'Book now' },
  });
  assert.deepEqual(canvaCalls(ctx, '/exports')[0].body, { design_id: 'DES1', format: { type: 'jpg', quality: 92, pages: [1] } });
  assert.equal(post.image.source, 'canva');
  assert.equal(post.image.width, 1201);
  assert.equal(post.canva_design_id, 'DES1');
  assert.match(post.canva_edit_url, /canva\.com/);
  assert.notEqual(post.photo.id, post.image.id);
  // a 1200×630 Facebook-style design is accepted for Instagram too, and publishing uses the Canva export
  await connectMeta(ctx, ctx.ws);
  await ctx.app.engine.approve(id, 'Sam');
  await ctx.app.engine.drain();
  assert.equal((await ctx.app.engine.getPost(id)).status, 'published');
  assert.equal(ctx.state.graph.find((x) => x.path === '111/photos').form.url, post.image.url);
});

test('text feedback re-fills the template with the same photo; picture feedback edits the photo first', async () => {
  const ctx = await setup();
  const id = await ctx.newPost();
  const first = await ctx.app.engine.getPost(id);

  await ctx.app.engine.requestChanges(id, 'Sam', 'Shorter headline please');
  await ctx.app.engine.drain();
  let post = await ctx.app.engine.getPost(id);
  assert.equal(gemini(ctx).length, 1, 'no new photo for a text change');
  assert.equal(post.photo.id, first.photo.id);
  assert.equal(canvaCalls(ctx, '/autofills').at(-1).body.data.HEADLINE.text, 'Shorter headline');
  assert.equal(post.canva_design_id, 'DES2');
  assert.notEqual(post.image.id, first.image.id);

  await ctx.app.engine.requestChanges(id, 'Sam', 'Make the picture brighter');
  await ctx.app.engine.drain();
  post = await ctx.app.engine.getPost(id);
  const edit = gemini(ctx).at(-1);
  assert.equal(gemini(ctx).length, 2);
  assert.match(edit.input[0].text, /Edit the attached image[\s\S]*picture brighter[\s\S]*No text/);
  assert.equal(edit.input[1].type, 'image');
  assert.notEqual(post.photo.id, first.photo.id);
  assert.equal(post.canva_design_id, 'DES3');
  assert.equal(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM media WHERE post_id = ?', [id])).n), 2, 'one photo and one design image are kept');
});

test('if Canva refuses, the post still reaches review with the reason, and Generate again retries with the same photo', async () => {
  const ctx = await setup();
  ctx.state.canvaFail = 'trial_quota_exceeded';
  const id = await ctx.newPost();
  let post = await ctx.app.engine.getPost(id);
  assert.equal(post.status, 'in_review');
  assert.equal(post.image, null);
  assert.ok(post.photo);
  const ev = await ctx.db.get(`SELECT note FROM post_events WHERE post_id = ? AND kind = 'canva_failed'`, [id]);
  assert.match(ev.note, /Autofill allowance/);
  await assert.rejects(() => ctx.app.engine.approve(id, 'Sam'), /needs an image/);
  await assert.rejects(() => ctx.app.engine.generateImageNow(id, 'Sam'), /Autofill allowance/);
  ctx.state.canvaFail = '';
  await ctx.app.engine.generateImageNow(id, 'Sam');
  post = await ctx.app.engine.getPost(id);
  assert.equal(post.image.source, 'canva');
  assert.equal(gemini(ctx).length, 1, 'the photo is reused');
});

test('an expired Canva token is refreshed and the new single-use refresh token is stored', async () => {
  const ctx = await setup({ expiresAt: Date.now() - 1000 });
  const id = await ctx.newPost();
  assert.equal((await ctx.app.engine.getPost(id)).image.source, 'canva');
  const refresh = canvaCalls(ctx, '/oauth/token');
  assert.equal(refresh.length, 1);
  assert.equal(refresh[0].body.refresh_token, 'refresh-0');
  assert.equal(refresh[0].auth, `Basic ${Buffer.from('OC-123456:canva-secret').toString('base64')}`);
  assert.match(canvaCalls(ctx, '/url-asset-uploads')[0].auth, /^Bearer access-\d+$/);
  // a second post uses the stored token without refreshing again
  await ctx.newPost();
  assert.equal(canvaCalls(ctx, '/oauth/token').length, 1);
});

test('a design edited by hand in Canva can be imported again', async () => {
  const ctx = await setup();
  const id = await ctx.newPost();
  const before = (await ctx.app.engine.getPost(id)).image;
  await ctx.app.engine.importFromCanva(id, 'Sam');
  const after = (await ctx.app.engine.getPost(id)).image;
  assert.notEqual(after.id, before.id);
  assert.equal(after.source, 'canva');
  assert.equal(canvaCalls(ctx, '/exports').at(-1).body.design_id, 'DES1');
  assert.equal(canvaCalls(ctx, '/autofills').length, 1, 'no new design is made');
});

test('connecting Canva through the pages: sign-in, template choice, field choices', async () => {
  const ctx = await makeApp();
  const web = await serve(ctx.app);
  try {
    await web.post('/setup', { token: 'setup-token', name: 'Sam', email: 'sam@example.com', password: 'a-long-password' });
    const csrf = csrfOf((await web.get('/')).text);
    const ws = await addBrand(ctx.db);
    assert.match((await web.get(`/brands/${ws}/connect/canva`)).location, /err=Add%20the%20Canva/);
    await web.post('/settings/canva', { _csrf: csrf, canva_client_id: 'OC-123456', canva_client_secret: 'canva-secret' });
    assert.ok(!(await web.get('/settings')).text.includes('canva-secret'));
    assert.match((await web.get(`/brands/${ws}`)).text, /Connect Canva/);

    const auth = new URL((await web.get(`/brands/${ws}/connect/canva`)).location);
    assert.equal(auth.origin + auth.pathname, 'https://www.canva.com/api/oauth/authorize');
    assert.equal(auth.searchParams.get('redirect_uri'), 'http://localhost/api/oauth/canva/callback');
    assert.match(auth.searchParams.get('scope'), /brandtemplate:content:read.*design:content:write/);
    const state = auth.searchParams.get('state');

    assert.match((await web.get(`/api/oauth/canva/callback?state=${'0'.repeat(48)}&code=x`)).location, /expired/);
    const cb = await web.get(`/api/oauth/canva/callback?state=${state}&code=the-code`);
    assert.match(cb.location, new RegExp(`^/brands/${ws}/canva\\?msg=Connected%20to%20Canva%20as%20GTV%20Designs`));
    const exchange = ctx.state.canva.find((c) => c.path === '/oauth/token').body;
    assert.equal(exchange.code, 'the-code');
    // the verifier sent to Canva matches the challenge from the sign-in link (PKCE)
    assert.equal(crypto.createHash('sha256').update(exchange.code_verifier).digest('base64url'), auth.searchParams.get('code_challenge'));
    const row = await ctx.db.get(`SELECT * FROM connections WHERE workspace_id = ? AND platform = 'canva'`, [ws]);
    assert.ok(!row.token.includes('access-'), 'tokens are encrypted at rest');
    assert.match((await web.get(`/api/oauth/canva/callback?state=${state}&code=again`)).location, /expired/, 'the link works once');

    const page = await web.get(`/brands/${ws}/canva`);
    assert.match(page.text, /FB offer post/);
    assert.match(page.text, /How to prepare a template/);
    assert.match((await web.post(`/brands/${ws}/canva/template`, { _csrf: csrf, template_id: 'NOPE' })).location, /err=Choose/);
    assert.match((await web.post(`/brands/${ws}/canva/template`, { _csrf: csrf, template_id: 'TPL1' })).location, /selected/);
    const fieldsPage = await web.get(`/brands/${ws}/canva`);
    assert.match(fieldsPage.text, /What fills each field/);
    assert.match(fieldsPage.text, /SALES<\/span>: chart fields are left as designed/);
    let map = JSON.parse((await ctx.db.get(`SELECT data FROM connections WHERE workspace_id = ? AND platform = 'canva'`, [ws])).data);
    assert.deepEqual(Object.fromEntries(Object.entries(map.fields).map(([k, v]) => [k, v.use])), { PHOTO: 'photo', HEADLINE: 'headline', CTA_BUTTON: 'cta', SALES: 'none' });

    await web.post(`/brands/${ws}/canva/fields`, { _csrf: csrf, use_PHOTO: 'photo', use_HEADLINE: 'headline', use_CTA_BUTTON: 'bogus', shape: '4:5' });
    map = JSON.parse((await ctx.db.get(`SELECT data FROM connections WHERE workspace_id = ? AND platform = 'canva'`, [ws])).data);
    assert.equal(map.fields.CTA_BUTTON.use, 'none');
    assert.equal(map.shape, '4:5');
    assert.match((await web.get(`/brands/${ws}`)).text, /Template: <strong>FB offer post/);

    await web.post(`/brands/${ws}/disconnect/canva`, { _csrf: csrf });
    assert.equal(await ctx.db.get(`SELECT id FROM connections WHERE workspace_id = ? AND platform = 'canva'`, [ws]), undefined);
  } finally { await web.close(); }
});
