import { esc, formatTime, PLATFORMS, STATUS_LABELS, MAX_VERSIONS, PUBLISHABLE } from './util.js';
import { instagramProblem } from './media.js';
import { FIELD_USES } from './services/canva.js';

const FONTS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap';

function page({ title, body, refresh }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh ? `<meta http-equiv="refresh" content="${Number(refresh)}">` : ''}
<title>${esc(title)} · Content Pipeline</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
${body}
</body>
</html>`;
}

const notice = (kind, text) => (text ? `<div class="notice ${kind}" role="status">${esc(text)}</div>` : '');
const csrfField = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
const pill = (status) => `<span class="pill ${esc(status)}">${esc(STATUS_LABELS[status] || status)}</span>`;

/** Signed-in page with the top navigation. */
export function layout({ title, user, csrf, active, body, refresh, msg, err }) {
  const link = (href, label, key) => `<a href="${href}"${active === key ? ' class="on" aria-current="page"' : ''}>${label}</a>`;
  return page({
    title, refresh,
    body: `<header class="top"><div class="top-in">
  <a class="brand" href="/">Content Pipeline</a>
  <nav class="nav" aria-label="Main">${link('/', 'Posts', 'posts')}${link('/brands', 'Brands', 'brands')}${link('/settings', 'Settings', 'settings')}</nav>
  <div class="who"><span>${esc(user.name)}</span>
    <form method="post" action="/logout">${csrfField(csrf)}<button class="btn link" type="submit">Sign out</button></form>
  </div>
</div></header>
<main>
${notice('ok', msg)}${notice('bad', err)}
${body}
</main>`,
  });
}

export function messagePage({ title, heading, text, status }) {
  return page({ title, body: `<div class="narrow"><div class="card"><h1>${esc(heading)}</h1><p class="muted">${esc(text)}</p>${status === 404 ? '<p><a href="/">Back to posts</a></p>' : ''}</div></div>` });
}

export function loginPage({ err, msg, email = '', hasUsers }) {
  return page({
    title: 'Sign in',
    body: `<div class="narrow">
<h1>Content Pipeline</h1>
${notice('ok', msg)}${notice('bad', err)}
${hasUsers ? `<form class="card" method="post" action="/login">
  <label for="email">Email<input id="email" name="email" type="email" value="${esc(email)}" autocomplete="username" required></label>
  <label for="password">Password<input id="password" name="password" type="password" autocomplete="current-password" required></label>
  <button class="btn primary" type="submit">Sign in</button>
</form>` : notice('info', 'No account exists yet. Open your one-time setup link to create the owner account.')}
</div>`,
  });
}

export function setupPage({ token, err, values = {} }) {
  return page({
    title: 'Create owner account',
    body: `<div class="narrow">
<h1>Create the owner account</h1>
<p class="muted">This runs once. After it, this setup link stops working.</p>
${notice('bad', err)}
<form class="card" method="post" action="/setup">
  <input type="hidden" name="token" value="${esc(token)}">
  <label for="name">Your name<input id="name" name="name" type="text" value="${esc(values.name)}" required maxlength="100"></label>
  <label for="email">Email<input id="email" name="email" type="email" value="${esc(values.email)}" autocomplete="username" required maxlength="190"></label>
  <label for="password">Password <small>At least 10 characters</small><input id="password" name="password" type="password" autocomplete="new-password" required minlength="10"></label>
  <button class="btn primary" type="submit">Create account</button>
</form>
</div>`,
  });
}

export function dashboardBody({ posts, brands, counts, filter, claudeReady }) {
  if (!brands.length) {
    return `<div class="card empty"><h1>Add your first brand</h1>
<p class="muted">A brand holds the colours, tone of voice and Slack channel for one business. Every post belongs to a brand.</p>
<a class="btn primary" href="/brands/new">Add a brand</a></div>`;
  }
  const qs = (over) => {
    const p = new URLSearchParams();
    const next = { ...filter, ...over };
    if (next.brand) p.set('brand', next.brand);
    if (next.status) p.set('status', next.status);
    const s = p.toString();
    return s ? `/?${s}` : '/';
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const statusLinks = [['', `All ${total}`], ...Object.keys(STATUS_LABELS).filter((s) => counts[s]).map((s) => [s, `${STATUS_LABELS[s]} ${counts[s]}`])]
    .map(([s, label]) => `<a href="${qs({ status: s })}"${(filter.status || '') === s ? ' class="on"' : ''}>${esc(label)}</a>`).join('');
  const rows = posts.map((p) => `<tr>
  <td><a href="/posts/${p.id}">${esc(p.content?.headline || p.brief.goal || 'Untitled')}</a><div class="muted">${esc(p.brand_name)}</div></td>
  <td>${p.platforms.map((x) => esc(PLATFORMS[x].label)).join(', ')}</td>
  <td>${pill(p.status)}</td>
  <td class="muted">${esc(formatTime(p.updated_at, p.timezone))}</td>
</tr>`).join('');
  return `${claudeReady ? '' : `<div class="notice warn">Claude is not connected yet, so new briefs cannot be written. <a href="/settings">Add your Claude API key in Settings.</a></div>`}
<div class="row spread">
  <h1>Posts</h1>
  <a class="btn primary" href="/posts/new${filter.brand ? `?brand=${esc(filter.brand)}` : ''}">New brief</a>
</div>
<div class="row spread">
  <div class="filters" aria-label="Filter by status">${statusLinks}</div>
  <form method="get" action="/" class="row">
    ${filter.status ? `<input type="hidden" name="status" value="${esc(filter.status)}">` : ''}
    <label for="brand" class="muted" style="flex-direction:row;align-items:center;gap:8px">Brand
    <select id="brand" name="brand" style="width:auto"><option value="">All brands</option>${brands.map((b) => `<option value="${b.id}"${String(filter.brand) === String(b.id) ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
    <button class="btn" type="submit">Show</button>
  </form>
</div>
${posts.length ? `<div class="tbl"><table>
<thead><tr><th>Post</th><th>Platforms</th><th>Status</th><th>Updated</th></tr></thead>
<tbody>${rows}</tbody></table></div>` : `<div class="card empty"><h2>No posts here yet</h2><p class="muted">Write a brief and Claude drafts the post for review.</p><a class="btn primary" href="/posts/new">New brief</a></div>`}`;
}

export function brandsBody({ brands }) {
  const rows = brands.map((b) => `<tr>
  <td><a href="/brands/${b.id}">${esc(b.name)}</a></td>
  <td><span class="swatch" style="background:${esc(b.primary_color)}"></span> <span class="swatch" style="background:${esc(b.secondary_color)}"></span></td>
  <td>${b.slack_channel ? `<span class="mono">${esc(b.slack_channel)}</span>` : '<span class="muted">Dashboard only</span>'}</td>
  <td class="muted">${Number(b.post_count)} posts</td>
</tr>`).join('');
  return `<div class="row spread"><h1>Brands</h1><a class="btn primary" href="/brands/new">Add a brand</a></div>
${brands.length ? `<div class="tbl"><table><thead><tr><th>Brand</th><th>Colours</th><th>Slack approval</th><th>Posts</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="card empty"><h2>No brands yet</h2><p class="muted">Add one for each business you create content for.</p></div>`}`;
}

function connectionsCard({ brand, csrf, metaReady, connection }) {
  if (!brand.id) return '';
  let body;
  if (connection) {
    body = `<p>Facebook Page: <strong>${esc(connection.account_name)}</strong></p>
  <p>Instagram: ${connection.extra_name ? `<strong>@${esc(connection.extra_name)}</strong>` : '<span class="muted">No Instagram business account is linked to this Page. Link one in Instagram settings, then reconnect.</span>'}</p>
  <p class="muted">Connected by ${esc(connection.connected_by)}.</p>
  <div class="row"><a class="btn" href="/brands/${brand.id}/connect/meta">Reconnect</a>
  <form method="post" action="/brands/${brand.id}/disconnect/meta">${csrfField(csrf)}<button class="btn bad" type="submit">Disconnect</button></form></div>`;
  } else if (metaReady) {
    body = `<p class="muted">Connect the brand’s Facebook Page. Its linked Instagram business account is connected at the same time. Facebook asks you to choose the Page and confirm the permissions.</p>
  <div><a class="btn primary" href="/brands/${brand.id}/connect/meta">Connect Facebook and Instagram</a></div>`;
  } else {
    body = '<p class="muted">Add the Meta app ID and secret in <a href="/settings">Settings</a> first.</p>';
  }
  return `<div class="card">
  <div class="row spread"><h2>Social accounts</h2>${connection ? '<span class="pill approved">Connected</span>' : '<span class="pill">Not connected</span>'}</div>
  ${body}
  <p class="muted">LinkedIn, TikTok and X are not connected yet. Posts for them are kept but not published.</p>
</div>`;
}

function logoCard({ brand, csrf, logo }) {
  if (!brand.id) return '';
  return `<div class="card">
  <div class="row spread"><h2>Logo</h2>${logo ? '<span class="pill approved">Saved</span>' : '<span class="pill">Not set</span>'}</div>
  <p class="muted">Generated images place this logo in a corner. Without it, images are made with no logo.</p>
  ${logo ? `<img class="logo-preview" src="${esc(logo.url)}" alt="${esc(brand.name)} logo" width="${logo.width}" height="${logo.height}">` : ''}
  <form class="stack" method="post" action="/brands/${brand.id}/logo" data-upload data-csrf="${esc(csrf)}" data-max-mb="2">
    <label for="logo_file">${logo ? 'Replace the logo' : 'Upload the logo'} <small>PNG or JPG, up to 2 MB. A PNG with a transparent background works best.</small>
      <input id="logo_file" type="file" accept="image/png,image/jpeg"></label>
    <div class="row"><button class="btn primary" type="submit">Upload</button><span class="muted" data-status role="status"></span></div>
  </form>
</div>`;
}

function canvaCard({ brand, csrf, canvaReady, canvaConn }) {
  if (!brand.id) return '';
  let body;
  if (canvaConn?.extra_id) {
    body = `<p>Template: <strong>${esc(canvaConn.extra_name)}</strong></p>
  <p class="muted">Canva account: ${esc(canvaConn.account_name)}. Each post gets a Gemini photo placed in this template, and the finished design is exported from Canva.</p>
  <div class="row"><a class="btn" href="/brands/${brand.id}/canva">Change template or fields</a>
  <form method="post" action="/brands/${brand.id}/disconnect/canva">${csrfField(csrf)}<button class="btn bad" type="submit">Disconnect</button></form></div>`;
  } else if (canvaConn) {
    body = `<p class="muted">Connected as ${esc(canvaConn.account_name)}, but no template is chosen yet.</p>
  <div><a class="btn primary" href="/brands/${brand.id}/canva">Choose the template</a></div>`;
  } else if (canvaReady) {
    body = `<p class="muted">Use one of your Canva brand templates for this brand’s posts. Gemini makes the photo, Canva places it in the template with the headline, and the finished design comes back here for approval.</p>
  <div><a class="btn primary" href="/brands/${brand.id}/connect/canva">Connect Canva</a></div>`;
  } else {
    body = '<p class="muted">Add the Canva Client ID and secret in <a href="/settings">Settings</a> first.</p>';
  }
  return `<div class="card">
  <div class="row spread"><h2>Canva template</h2>${canvaConn?.extra_id ? '<span class="pill approved">In use</span>' : '<span class="pill">Not set</span>'}</div>
  ${body}
</div>`;
}

export function canvaBody({ brand, row, templates, loadError, csrf }) {
  const caps = row.map.capabilities || [];
  const noAutofill = caps.length > 0 && !caps.includes('autofill');
  const fields = Object.entries(row.map.fields || {});
  const shapes = { '1:1': 'Square (1:1)', '4:5': 'Portrait (4:5)', '3:4': 'Portrait (3:4)', '9:16': 'Tall (9:16)', '4:3': 'Landscape (4:3)', '16:9': 'Wide (16:9)' };
  return `<p><a href="/brands/${brand.id}">← ${esc(brand.name)}</a></p>
<h1>Canva template for ${esc(brand.name)}</h1>
${noAutofill ? notice('warn', 'Canva reports that this account cannot use Autofill. It needs Canva Pro, Teams or Enterprise with multi-factor authentication turned on. You can still choose a template, but filling it may be refused.') : ''}
${loadError ? notice('bad', loadError) : ''}
<form class="card" method="post" action="/brands/${brand.id}/canva/template">
  ${csrfField(csrf)}
  <h2>1. Choose the template</h2>
  ${templates.length ? `<div class="pages">${templates.map((t, i) => `<label for="tpl_${i}"><input id="tpl_${i}" type="radio" name="template_id" value="${esc(t.id)}"${t.id === row.extra_id ? ' checked' : ''} required>
    <span><strong>${esc(t.title)}</strong></span></label>`).join('')}</div>
  <div><button class="btn primary" type="submit">Use this template</button></div>`
    : `<p class="muted">${loadError ? 'The templates could not be loaded.' : 'No brand templates with data fields were found in this Canva account.'}</p>`}
  <details><summary>How to prepare a template in Canva</summary>
    <ol class="steps">
      <li>Open your design in Canva. In the side panel choose <strong>Apps → Bulk Create</strong>, then <strong>Labels</strong>.</li>
      <li>Click the photo and add a data field, for example <span class="mono">PHOTO</span>. Click the headline text and add <span class="mono">HEADLINE</span>. Optionally a button text as <span class="mono">CTA</span>.</li>
      <li>Publish the design as a <strong>Brand template</strong> (Share → Brand template).</li>
      <li>Reload this page. The template appears in the list.</li>
    </ol>
  </details>
</form>
${row.extra_id ? `<form class="card" method="post" action="/brands/${brand.id}/canva/fields">
  ${csrfField(csrf)}
  <h2>2. What fills each field of “${esc(row.extra_name)}”</h2>
  ${fields.length ? fields.map(([name, f], i) => (FIELD_USES[f.type]
    ? `<label for="use_${i}"><span><span class="mono">${esc(name)}</span> <small>${f.type === 'image' ? 'image field' : 'text field'}</small></span>
    <select id="use_${i}" name="use_${esc(name)}">${Object.entries(FIELD_USES[f.type]).map(([k, label]) => `<option value="${k}"${f.use === k ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`
    : `<p class="muted"><span class="mono">${esc(name)}</span>: ${esc(f.type)} fields are left as designed.</p>`)).join('')
    : '<p class="muted">This template has no data fields.</p>'}
  <label for="shape">Shape of the photo area <small>Gemini makes the photo in this shape so it fits the template without awkward cropping.</small>
    <select id="shape" name="shape">${Object.entries(shapes).map(([k, label]) => `<option value="${k}"${(row.map.shape || '1:1') === k ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
  <div><button class="btn primary" type="submit">Save</button></div>
</form>` : ''}`;
}

export function brandFormBody({ brand, csrf, err, slackReady, metaReady, connection, logo, canvaReady, canvaConn }) {
  const b = brand;
  const isNew = !b.id;
  return `<p><a href="/brands">← Brands</a></p>
<h1>${isNew ? 'Add a brand' : esc(b.name)}</h1>
${notice('bad', err)}
<form class="card" method="post" action="${isNew ? '/brands' : `/brands/${b.id}`}">
  ${csrfField(csrf)}
  <label for="name">Brand name<input id="name" name="name" type="text" value="${esc(b.name)}" required maxlength="100"></label>
  <div class="row">
    <label for="primary_color">Main colour<input id="primary_color" name="primary_color" type="color" value="${esc(b.primary_color)}"></label>
    <label for="secondary_color">Second colour<input id="secondary_color" name="secondary_color" type="color" value="${esc(b.secondary_color)}"></label>
    <label for="timezone" style="flex:1;min-width:200px">Time zone <input id="timezone" name="timezone" type="text" value="${esc(b.timezone)}" required></label>
  </div>
  <label for="tone">Tone of voice <small>How the brand sounds. Example: warm, plain-spoken, a little playful, never salesy.</small>
    <textarea id="tone" name="tone" maxlength="2000">${esc(b.tone)}</textarea></label>
  <label for="audience">Audience <small>Who the posts are for.</small>
    <textarea id="audience" name="audience" maxlength="2000">${esc(b.audience)}</textarea></label>
  <label for="banned_words">Words to avoid <small>Comma-separated words or phrases Claude must never use.</small>
    <input id="banned_words" name="banned_words" type="text" value="${esc(b.banned_words)}" maxlength="1000"></label>
  <label for="sample_posts">Posts you like <small>Paste two or three past posts so Claude can match the style. Optional.</small>
    <textarea id="sample_posts" name="sample_posts" maxlength="6000">${esc(b.sample_posts)}</textarea></label>
  <label for="slack_channel">Slack approval channel ID <small>${slackReady ? 'Example: C0123ABCD. Find it in Slack under the channel name → About. Invite the app to that channel. Leave empty to review in the dashboard only.' : 'Connect Slack in Settings first. Until then posts are reviewed in the dashboard.'}</small>
    <input id="slack_channel" name="slack_channel" type="text" value="${esc(b.slack_channel)}" maxlength="30" placeholder="C0123ABCD"></label>
  <label for="slack_request_channel">Slack request channel ID <small>Optional. Every message someone posts in this channel becomes a brief for this brand, written and designed automatically. Use a channel kept only for requests, and invite the app to it.</small>
    <input id="slack_request_channel" name="slack_request_channel" type="text" value="${esc(b.slack_request_channel)}" maxlength="30" placeholder="C0456EFGH"></label>
  <div class="row"><button class="btn primary" type="submit">${isNew ? 'Add brand' : 'Save changes'}</button></div>
</form>
${canvaCard({ brand: b, csrf, canvaReady, canvaConn })}
${logoCard({ brand: b, csrf, logo })}
${connectionsCard({ brand: b, csrf, metaReady, connection })}`;
}

export function pickPageBody({ brand, pages, state, csrf }) {
  return `<p><a href="/brands/${brand.id}">← ${esc(brand.name)}</a></p>
<h1>Choose the Facebook Page for ${esc(brand.name)}</h1>
<form class="card" method="post" action="/brands/${brand.id}/connect/meta/pick">
  ${csrfField(csrf)}
  <input type="hidden" name="state" value="${esc(state)}">
  <div class="pages">${pages.map((p, i) => `<label for="page_${i}"><input id="page_${i}" type="radio" name="page_id" value="${esc(p.id)}"${i === 0 ? ' checked' : ''}>
    <span><strong>${esc(p.name)}</strong><br><span class="muted">${p.igUsername ? `Instagram @${esc(p.igUsername)}` : 'No Instagram business account linked'}</span></span></label>`).join('')}</div>
  <div><button class="btn primary" type="submit">Connect this Page</button></div>
</form>`;
}

export function newPostBody({ brands, csrf, err, values = {} }) {
  const chosen = new Set([].concat(values.platforms || ['facebook', 'instagram']));
  return `<p><a href="/">← Posts</a></p>
<h1>New brief</h1>
${notice('bad', err)}
<form class="card" method="post" action="/posts">
  ${csrfField(csrf)}
  <label for="brand">Brand<select id="brand" name="brand" required>${brands.map((b) => `<option value="${b.id}"${String(values.brand) === String(b.id) ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
  <label for="goal">What is this post about? <small>One or two sentences. Example: Announce free pickup for parcels to the UK during December.</small>
    <textarea id="goal" name="goal" required maxlength="1000">${esc(values.goal)}</textarea></label>
  <label for="details">Details and offer <small>Prices, dates, links, anything that must be exact. Claude only states facts you give here.</small>
    <textarea id="details" name="details" maxlength="3000">${esc(values.details)}</textarea></label>
  <fieldset style="border:0;padding:0;margin:0" class="stack">
    <legend style="font-weight:500;font-size:14px;padding:0;margin-bottom:6px">Platforms</legend>
    <div class="checks">${Object.entries(PLATFORMS).map(([k, p]) => `<label for="p_${k}"><input id="p_${k}" type="checkbox" name="platforms" value="${k}"${chosen.has(k) ? ' checked' : ''}> ${esc(p.label)}</label>`).join('')}</div>
  </fieldset>
  <div class="row">
    <label for="language" style="flex:1;min-width:160px">Language<select id="language" name="language">${['English', 'Sinhala', 'Tamil'].map((l) => `<option${values.language === l ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <label for="publish_at" style="flex:1;min-width:200px">Publish time <small>Optional. In the brand's time zone.</small><input id="publish_at" name="publish_at" type="datetime-local" value="${esc(values.publish_at)}"></label>
  </div>
  <div class="row"><button class="btn primary" type="submit">Write the post</button></div>
</form>`;
}

function textOn(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#161a2b' : '#ffffff';
}

const EVENT_LABELS = {
  created: 'Brief submitted', generated: 'Content written', slack_sent: 'Sent to Slack for review',
  slack_failed: 'Slack message failed', approved: 'Approved', rejected: 'Rejected',
  changes_requested: 'Changes requested', failed: 'Failed', retried: 'Retried',
  image_added: 'Image added', image_removed: 'Image removed', published: 'Published',
  photo_generated: 'Photo generated', photo_edited: 'Photo changed', canva_composed: 'Designed in Canva',
  canva_failed: 'Canva step failed', canva_imported: 'Imported from Canva',
  image_generated: 'Image generated', image_edited: 'Image changed', image_failed: 'Image generation failed', image_kept: 'Image not changed',
  publish_failed: 'Publishing failed', publish_retried: 'Publishing retried',
};

const RESULT_LABELS = { pending: 'Waiting', published: 'Published', failed: 'Failed', skipped: 'Not connected' };
const RESULT_PILL = { pending: 'publishing', published: 'published', failed: 'failed', skipped: '' };

function imageCard({ post, brand, csrf, geminiReady }) {
  const c = post.content;
  const canEdit = ['generating', 'in_review', 'approved', 'scheduled', 'publish_failed', 'failed'].includes(post.status);
  const igWarning = post.platforms.includes('instagram') ? instagramProblem(post.image) : '';
  const upload = canEdit ? `<form class="stack" method="post" action="/posts/${post.id}/image" data-upload data-csrf="${esc(csrf)}">
      <label for="image_file">${post.image ? 'Replace with your own design' : 'Upload your own design'} <small>JPG only, up to 8 MB. From Canva: Share → Download → JPG. For Instagram use 1080×1080 or 1080×1350.</small>
        <input id="image_file" type="file" accept="image/jpeg"></label>
      <div class="row"><button class="btn primary" type="submit">Upload</button><span class="muted" data-status role="status"></span></div>
    </form>` : '';
  const remove = post.image && canEdit
    ? `<form method="post" action="/posts/${post.id}/image/remove">${csrfField(csrf)}<button class="btn link" type="submit">Remove image</button></form>` : '';
  const shown = post.image
    ? `<img class="post-image" src="${esc(post.image.url)}" alt="${esc(c?.headline || 'Post image')}" width="${post.image.width}" height="${post.image.height}">
      <p class="muted">${post.image.width}×${post.image.height} · ${Math.round(post.image.size / 1024)} KB</p>`
    : c ? `<div class="preview" style="background:${esc(brand.primary_color)};color:${textOn(brand.primary_color)}"><span class="ph">${esc(c.headline)}</span><span class="pb">${esc(brand.name)}</span></div>
      <p class="muted">Layout sketch only. This is not published.</p>` : '';
  const canGenerate = geminiReady && c && ['in_review', 'approved', 'scheduled', 'publish_failed'].includes(post.status);
  const madeByGemini = ['gemini', 'canva'].includes(post.image?.source);
  const generate = canGenerate ? `<form class="stack" method="post" action="/posts/${post.id}/image/generate">${csrfField(csrf)}
      <label for="image_note">${post.image ? (madeByGemini ? 'Change this image' : 'Replace with a generated image') : 'Generate the image'} <small>${madeByGemini ? 'Say what to change, or leave empty for a completely new image.' : 'Optional: anything extra the image should show.'} Takes up to a minute.</small>
        <input id="image_note" name="note" type="text" maxlength="1000" placeholder="${madeByGemini ? 'Make the background lighter and the headline bigger' : ''}"></label>
      <div><button class="btn" type="submit">${post.image ? 'Generate again' : 'Generate with Gemini'}</button></div>
    </form>` : '';
  return `<div class="card"><h2>Image</h2>
    ${igWarning && canEdit ? `<div class="notice warn">${esc(igWarning)}</div>` : ''}
    ${shown}${post.image ? `<p class="muted">${{ gemini: 'Made by Gemini.', canva: 'Designed in your Canva template, with a photo from Gemini.' }[post.image.source] || 'Uploaded by hand.'}</p>` : ''}
    ${!post.image && post.photo ? `<div class="notice warn">The photo is ready but it has not been placed in the Canva template. See Activity for the reason, then use Generate again.</div><img class="post-image" src="${esc(post.photo.url)}" alt="Photo from Gemini" width="${post.photo.width}" height="${post.photo.height}">` : ''}
    ${post.canva_design_id && canEdit ? `<div class="row">${post.canva_edit_url ? `<a class="btn" href="${esc(post.canva_edit_url)}" target="_blank" rel="noopener">Edit in Canva</a>` : ''}
      <form method="post" action="/posts/${post.id}/canva/import">${csrfField(csrf)}<button class="btn" type="submit">Import the edited design</button></form></div>
      <p class="muted">Adjust the design in Canva if needed, then import it so the approved post uses your edit.</p>` : ''}
    ${remove}${generate}${upload}
    ${c?.image_prompt ? `<div class="caption"><h3>Image idea from Claude</h3><p>${esc(c.image_prompt)}</p></div>` : ''}
  </div>`;
}

function publishingCard({ post, results, connection, csrf }) {
  if (!results.length) {
    if (!['in_review', 'approved'].includes(post.status)) return '';
    const unsupported = post.platforms.filter((p) => !PUBLISHABLE.includes(p));
    return `<div class="card"><h2>Publishing</h2>
      <p>${connection ? `Goes to the <strong>${esc(connection.account_name)}</strong> Facebook Page${connection.extra_name ? ` and Instagram <strong>@${esc(connection.extra_name)}</strong>` : ''} when approved.` : 'This brand is not connected to Facebook or Instagram yet, so approving will not publish anything. Connect it on the brand page.'}</p>
      ${unsupported.length ? `<p class="muted">${unsupported.map((p) => esc(PLATFORMS[p].label)).join(', ')}: not connected yet, will be skipped.</p>` : ''}
    </div>`;
  }
  const rows = results.map((r) => `<li><span><strong>${esc(PLATFORMS[r.platform]?.label || r.platform)}</strong>${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">View post</a>` : ''}</span>
    <span class="pill ${RESULT_PILL[r.status] || ''}">${esc(RESULT_LABELS[r.status] || r.status)}</span>
    ${r.error && r.status !== 'published' ? `<span class="err">${esc(r.error)}</span>` : ''}</li>`).join('');
  const retry = post.status === 'publish_failed'
    ? `<form method="post" action="/posts/${post.id}/publish/retry">${csrfField(csrf)}<button class="btn" type="submit">Retry failed platforms</button></form>` : '';
  return `<div class="card"><h2>Publishing</h2><ul class="results">${rows}</ul>${retry}</div>`;
}

export function postBody({ post, brand, events, results = [], connection = null, csrf, geminiReady = false }) {
  const c = post.content;
  const tz = brand.timezone;
  const state = {
    generating: notice('info', post.version ? 'Claude is rewriting this post with the requested changes. This page refreshes by itself.' : 'Claude is writing this post. This page refreshes by itself.'),
    failed: `<div class="notice bad"><strong>This post could not be written.</strong> ${esc(post.error)}
      <form method="post" action="/posts/${post.id}/retry" style="margin-top:10px">${csrfField(csrf)}<button class="btn" type="submit">Try again</button></form></div>`,
    approved: notice('ok', `Approved by ${post.decided_by} on ${formatTime(post.decided_at, tz)}. This post was approved before publishing was set up, so it was not published.`),
    scheduled: notice('info', `Approved by ${post.decided_by}. Publishes ${formatTime(post.publish_at, tz)}.`),
    publishing: notice('info', 'Publishing now. This page refreshes by itself.'),
    published: notice('ok', `Approved by ${post.decided_by} and published.`),
    publish_failed: notice('bad', 'Publishing did not finish on every platform. See Publishing below.'),
    rejected: notice('bad', `Rejected by ${post.decided_by} on ${formatTime(post.decided_at, tz)}.`),
  }[post.status] || '';

  const captions = c ? post.platforms.map((p) => {
    const text = c.captions[p] || '';
    const over = text.length > PLATFORMS[p].limit;
    return `<div class="caption"><div class="row spread"><h3>${esc(PLATFORMS[p].label)}</h3><span class="count${over ? ' over' : ''}">${text.length} / ${PLATFORMS[p].limit} characters</span></div><p>${esc(text)}</p></div>`;
  }).join('') : '';

  const canRevise = post.version < MAX_VERSIONS;
  const review = post.status === 'in_review' ? `<div class="card">
  <h2>Review</h2>
  ${post.slack_ts ? '<p class="muted">Also waiting in Slack. The first decision wins.</p>' : ''}
  <form method="post" action="/posts/${post.id}/approve">${csrfField(csrf)}<button class="btn ok" type="submit">Approve</button></form>
  ${canRevise ? `<form method="post" action="/posts/${post.id}/changes" class="stack">${csrfField(csrf)}
    <label for="note">What should change?<textarea id="note" name="note" required maxlength="1500" placeholder="Make the headline shorter and mention the December deadline."></textarea></label>
    <div><button class="btn" type="submit">Request changes</button></div></form>`
    : `<p class="muted">This post already had ${MAX_VERSIONS - 1} rounds of changes. Approve it, reject it, or start a new brief.</p>`}
  <details><summary>Reject this post</summary>
    <form method="post" action="/posts/${post.id}/reject" class="stack" style="margin-top:10px">${csrfField(csrf)}
    <label for="reason">Reason <small>Optional</small><input id="reason" name="note" type="text" maxlength="500"></label>
    <div><button class="btn bad" type="submit">Reject</button></div></form>
  </details>
</div>` : '';

  const timeline = events.map((e) => `<li><strong>${esc(EVENT_LABELS[e.kind] || e.kind)}</strong> <span class="muted">· ${esc(e.actor)} · ${esc(formatTime(e.created_at, tz))}</span>${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}</li>`).join('');

  return `<p><a href="/?brand=${brand.id}">← Posts</a></p>
<div class="row spread">
  <div class="stack" style="gap:4px"><h1>${esc(c?.headline || post.brief.goal)}</h1>
  <p class="muted">${esc(brand.name)} · ${post.platforms.map((x) => esc(PLATFORMS[x].label)).join(', ')}${post.publish_at ? ` · publish ${esc(formatTime(post.publish_at, tz))}` : ''}${post.version ? ` · version ${post.version}` : ''}</p></div>
  ${pill(post.status)}
</div>
${state}
<div class="grid2">
  <div class="stack" style="gap:24px">
    ${c ? `<div class="card"><h2>Captions</h2>${captions}
      <div class="caption"><h3>Hashtags</h3><p>${esc(c.hashtags.map((h) => `#${h}`).join(' '))}</p></div>
      <div class="caption"><h3>Call to action</h3><p>${esc(c.cta)}</p></div></div>` : ''}
    <div class="card"><h2>Brief</h2>
      <div class="caption"><h3>About</h3><p>${esc(post.brief.goal)}</p></div>
      ${post.brief.details ? `<div class="caption"><h3>Details and offer</h3><p>${esc(post.brief.details)}</p></div>` : ''}
      <p class="muted">Language: ${esc(post.brief.language || 'English')} · by ${esc(post.created_by)}</p></div>
  </div>
  <div class="stack" style="gap:24px">
    ${review}
    ${results.length ? publishingCard({ post, results, connection, csrf }) + imageCard({ post, brand, csrf, geminiReady }) : imageCard({ post, brand, csrf, geminiReady }) + publishingCard({ post, results, connection, csrf })}
    <div class="card"><h2>Activity</h2><ul class="timeline">${timeline}</ul></div>
  </div>
</div>`;
}

export function settingsBody({ csrf, state, appUrl }) {
  const saved = (on) => (on ? '<span class="pill approved">Saved</span>' : '<span class="pill">Not set</span>');
  return `<h1>Settings</h1>
<form class="card" method="post" action="/settings/claude">
  ${csrfField(csrf)}
  <div class="row spread"><h2>Claude</h2>${saved(state.claudeKey)}</div>
  <p class="muted">Claude writes the captions, headline and image prompt. Create a key at console.anthropic.com. Usage is billed to your Anthropic account.</p>
  <label for="anthropic_api_key">API key <small>${state.claudeKey ? 'A key is saved. Enter a new one only to replace it.' : 'Starts with sk-ant-'}</small>
    <input id="anthropic_api_key" name="anthropic_api_key" type="password" autocomplete="off" placeholder="${state.claudeKey ? '••••••••' : ''}"></label>
  <label for="claude_model">Model<input id="claude_model" name="claude_model" type="text" value="${esc(state.model)}" required maxlength="80"></label>
  <div class="row"><button class="btn primary" type="submit">Save</button>
    ${state.claudeKey ? `<button class="btn" type="submit" formaction="/settings/claude/test">Save and test</button>` : ''}</div>
</form>
<form class="card" method="post" action="/settings/slack">
  ${csrfField(csrf)}
  <div class="row spread"><h2>Slack approval</h2>${saved(state.slackToken && state.slackSecret)}</div>
  <p class="muted">Create a Slack app at api.slack.com/apps with the bot scope <span class="mono">chat:write</span>, install it to your workspace, and turn on Interactivity with this Request URL:</p>
  <p class="mono" style="overflow-wrap:anywhere">${esc(appUrl)}/api/slack/interactions</p>
  <label for="slack_bot_token">Bot token <small>${state.slackToken ? 'Saved. Enter a new one only to replace it.' : 'Starts with xoxb-'}</small>
    <input id="slack_bot_token" name="slack_bot_token" type="password" autocomplete="off" placeholder="${state.slackToken ? '••••••••' : ''}"></label>
  <label for="slack_signing_secret">Signing secret <small>${state.slackSecret ? 'Saved. Enter a new one only to replace it.' : 'On the Slack app’s Basic Information page'}</small>
    <input id="slack_signing_secret" name="slack_signing_secret" type="password" autocomplete="off" placeholder="${state.slackSecret ? '••••••••' : ''}"></label>
  <div class="row"><button class="btn primary" type="submit">Save</button>
    ${state.slackToken ? `<button class="btn" type="submit" formaction="/settings/slack/test">Save and test</button>` : ''}</div>
  <p class="muted">For requests from Slack, also turn on Event Subscriptions with this Request URL, subscribe to the bot events <span class="mono">message.channels</span> and <span class="mono">message.groups</span>, and add the scopes <span class="mono">channels:history</span> and <span class="mono">groups:history</span>:</p>
  <p class="mono" style="overflow-wrap:anywhere">${esc(state.eventsUrl)}</p>
  <p class="muted">Then set each brand’s Slack channel IDs on its brand page.</p>
</form>
<form class="card" method="post" action="/settings/gemini">
  ${csrfField(csrf)}
  <div class="row spread"><h2>Gemini images</h2>${saved(state.geminiKey)}</div>
  <p class="muted">Gemini makes the image for each post, with the headline and brand logo on it. Create a key at aistudio.google.com. Usage is billed to your Google account.</p>
  <label for="gemini_api_key">API key <small>${state.geminiKey ? 'A key is saved. Enter a new one only to replace it.' : 'From Google AI Studio → Get API key'}</small>
    <input id="gemini_api_key" name="gemini_api_key" type="password" autocomplete="off" placeholder="${state.geminiKey ? '••••••••' : ''}"></label>
  <div class="row">
    <label for="gemini_model" style="flex:2;min-width:220px">Image model<input id="gemini_model" name="gemini_model" type="text" value="${esc(state.geminiModel)}" required maxlength="80"></label>
    <label for="gemini_image_size" style="flex:1;min-width:140px">Image size<select id="gemini_image_size" name="gemini_image_size">
      <option value="1K"${state.geminiSize === '1K' ? ' selected' : ''}>Standard (1K)</option>
      <option value="2K"${state.geminiSize === '2K' ? ' selected' : ''}>Large (2K, costs more)</option></select></label>
  </div>
  <div class="row"><button class="btn primary" type="submit">Save</button>
    ${state.geminiKey ? `<button class="btn" type="submit" formaction="/settings/gemini/test">Save and test</button>` : ''}</div>
</form>
<form class="card" method="post" action="/settings/canva">
  ${csrfField(csrf)}
  <div class="row spread"><h2>Canva templates</h2>${saved(state.canvaClientId && state.canvaSecret)}</div>
  <p class="muted">Create an integration at canva.com/developers/integrations with the scopes for assets, brand templates, designs and profile, and add this as the redirect URL:</p>
  <p class="mono" style="overflow-wrap:anywhere">${esc(state.canvaRedirect)}</p>
  <label for="canva_client_id">Client ID<input id="canva_client_id" name="canva_client_id" type="text" value="${esc(state.canvaClientId)}" maxlength="80" placeholder="OC-..."></label>
  <label for="canva_client_secret">Client secret <small>${state.canvaSecret ? 'Saved. Enter a new one only to replace it.' : 'Generated on the integration’s Authentication page'}</small>
    <input id="canva_client_secret" name="canva_client_secret" type="password" autocomplete="off" placeholder="${state.canvaSecret ? '••••••••' : ''}"></label>
  <div class="row"><button class="btn primary" type="submit">Save</button></div>
  <p class="muted">Then connect Canva and choose a template on each brand page.</p>
</form>
<form class="card" method="post" action="/settings/meta">
  ${csrfField(csrf)}
  <div class="row spread"><h2>Facebook and Instagram</h2>${saved(state.metaAppId && state.metaSecret)}</div>
  <p class="muted">Create a Meta app at developers.facebook.com, add Facebook Login for Business, and add this as a Valid OAuth Redirect URI:</p>
  <p class="mono" style="overflow-wrap:anywhere">${esc(state.metaRedirect)}</p>
  <p class="muted">Privacy policy URL: <span class="mono">${esc(appUrl)}/privacy</span> · Data deletion URL: <span class="mono">${esc(appUrl)}/data-deletion</span></p>
  <label for="meta_app_id">App ID<input id="meta_app_id" name="meta_app_id" type="text" inputmode="numeric" value="${esc(state.metaAppId)}" maxlength="25"></label>
  <label for="meta_app_secret">App secret <small>${state.metaSecret ? 'Saved. Enter a new one only to replace it.' : 'App settings → Basic → App secret'}</small>
    <input id="meta_app_secret" name="meta_app_secret" type="password" autocomplete="off" placeholder="${state.metaSecret ? '••••••••' : ''}"></label>
  <label for="meta_config_id">Login configuration ID <small>Optional. Only if your Facebook Login for Business setup gave you one.</small>
    <input id="meta_config_id" name="meta_config_id" type="text" inputmode="numeric" value="${esc(state.metaConfigId)}" maxlength="25"></label>
  <div class="row"><button class="btn primary" type="submit">Save</button></div>
  <p class="muted">Then connect each brand on its brand page.</p>
</form>
<div class="card">
  <h2>System</h2>
  <p>Background check: ${state.lastTick ? `last ran ${esc(formatTime(state.lastTick))}` : '<span class="muted">has not run yet</span>'}</p>
  <p class="muted">A scheduled call runs every minute to retry failed steps. Posts still start writing the moment a brief is submitted.</p>
</div>`;
}

export function privacyPage({ appUrl }) {
  return page({
    title: 'Privacy policy',
    body: `<main class="legal">
<h1>Privacy policy</h1>
<p class="muted">Content Pipeline · ${esc(appUrl)}</p>
<p>Content Pipeline is a private tool used by our team to write, approve and publish social media posts for the brands we manage. It is not open to the public.</p>
<h2>What we access</h2>
<p>When a brand connects its Facebook Page and Instagram business account, we receive an access token from Meta, the Page name and ID, and the Instagram account name and ID. We use them only to publish posts that our team has approved, to that brand’s own Page and Instagram account.</p>
<h2>What we store</h2>
<p>We store the access token encrypted, the post text and images our team creates, and a record of who approved each post. We do not collect information about people who follow or interact with the Page.</p>
<h2>Sharing</h2>
<p>We do not sell or share this information. Post text is sent to Anthropic to draft captions, and review messages are sent to the brand’s Slack workspace.</p>
<h2>Deleting your data</h2>
<p>A brand can disconnect at any time from its brand page, which deletes the stored token immediately. See <a href="/data-deletion">data deletion</a>.</p>
</main>`,
  });
}

export function dataDeletionPage() {
  return page({
    title: 'Data deletion',
    body: `<main class="legal">
<h1>Data deletion</h1>
<p>To delete the data Content Pipeline holds for a Facebook Page or Instagram account:</p>
<ol>
<li>Remove the app in Facebook: Settings → Business integrations → select Content Pipeline → Remove.</li>
<li>Ask the agency team that manages your account to disconnect the brand in Content Pipeline. Disconnecting deletes the stored access token immediately.</li>
</ol>
<p>Posts already published to Facebook or Instagram stay on those platforms and can be deleted there.</p>
</main>`,
  });
}
