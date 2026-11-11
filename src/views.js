import { esc, formatTime, PLATFORMS, STATUS_LABELS, MAX_VERSIONS } from './util.js';

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

export function brandFormBody({ brand, csrf, err, slackReady }) {
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
  <div class="row"><button class="btn primary" type="submit">${isNew ? 'Add brand' : 'Save changes'}</button></div>
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
};

export function postBody({ post, brand, events, csrf }) {
  const c = post.content;
  const tz = brand.timezone;
  const state = {
    generating: notice('info', post.version ? 'Claude is rewriting this post with the requested changes. This page refreshes by itself.' : 'Claude is writing this post. This page refreshes by itself.'),
    failed: `<div class="notice bad"><strong>This post could not be written.</strong> ${esc(post.error)}
      <form method="post" action="/posts/${post.id}/retry" style="margin-top:10px">${csrfField(csrf)}<button class="btn" type="submit">Try again</button></form></div>`,
    approved: notice('ok', `Approved by ${post.decided_by} on ${formatTime(post.decided_at, tz)}. Publishing to social platforms is not connected yet, so nothing has been posted.`),
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
    ${c ? `<div class="card"><h2>Image</h2>
      <div class="preview" style="background:${esc(brand.primary_color)};color:${textOn(brand.primary_color)}"><span class="ph">${esc(c.headline)}</span><span class="pb">${esc(brand.name)}</span></div>
      <p class="muted">Layout sketch in the brand colour. Image generation is not connected yet.</p>
      <div class="caption"><h3>Image prompt</h3><p>${esc(c.image_prompt)}</p></div></div>` : ''}
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
  <p class="muted">Then set each brand’s Slack channel ID on its brand page.</p>
</form>
<div class="card">
  <h2>System</h2>
  <p>Background check: ${state.lastTick ? `last ran ${esc(formatTime(state.lastTick))}` : '<span class="muted">has not run yet</span>'}</p>
  <p class="muted">A scheduled call runs every minute to retry failed steps. Posts still start writing the moment a brief is submitted.</p>
</div>`;
}
