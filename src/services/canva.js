// Canva Connect API: fill a brand template with the generated photo and text, then export the design.
// The Canva user must be on a plan with Autofill (Pro, Teams or Enterprise) and have
// multi-factor authentication turned on.
import crypto from 'node:crypto';

const API = 'https://api.canva.com/rest/v1';

export const CANVA_SCOPES = [
  'asset:read', 'asset:write',
  'brandtemplate:content:read', 'brandtemplate:meta:read',
  'design:content:read', 'design:content:write', 'design:meta:read',
  'profile:read',
];

export class CanvaError extends Error {
  constructor(message, { permanent = false, code = null } = {}) { super(message); this.permanent = permanent; this.code = code; }
}

function explain(status, body) {
  const code = body?.code || body?.error;
  const msg = body?.message || body?.error_description || `HTTP ${status}`;
  if (status === 401 || code === 'invalid_grant') return 'The Canva connection has expired or was removed. Reconnect the brand to Canva.';
  if (status === 403) return `Canva refused this (${msg}). Autofill needs a Canva Pro, Teams or Enterprise account with multi-factor authentication turned on, and access to the template.`;
  if (status === 404) return `Canva could not find it (${msg}). The template may have been deleted or unpublished.`;
  if (status === 429) return 'Canva\'s usage limit was reached. It will be tried again shortly.';
  return `Canva: ${msg}`;
}

const JOB_ERRORS = {
  trial_quota_exceeded: 'Canva\'s free Autofill allowance for this account is used up.',
  license_required: 'The template uses premium Canva elements this account has not licensed.',
  approval_required: 'This Canva team requires design approval before export. Approve the design in Canva, then import it.',
  fetch_failed: 'Canva could not download the generated photo.',
  file_too_big: 'The generated photo is too large for Canva.',
};

/** PKCE pair for the sign-in redirect. */
export function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

export function createCanva({ fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 2000, pollTries = 40 } = {}) {
  async function call(method, path, token, body) {
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) { throw new CanvaError(`Could not reach Canva: ${e.message}`); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new CanvaError(explain(res.status, data), { permanent: ![429, 500, 502, 503, 504].includes(res.status), code: data?.code });
    return data;
  }

  async function token(body, clientId, clientSecret) {
    let res;
    try {
      res = await fetchImpl(`${API}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) { throw new CanvaError(`Could not reach Canva: ${e.message}`); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new CanvaError(explain(res.status, data), { permanent: res.status < 500 });
    return { access: data.access_token, refresh: data.refresh_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  }

  /** Start a job, then poll it until it succeeds or fails. */
  async function job(tokenValue, startPath, body, statusPath, what) {
    const started = await call('POST', startPath, tokenValue, body);
    let j = started.job || {};
    for (let i = 0; j.status === 'in_progress' && i < pollTries; i++) {
      await sleep(pollMs);
      j = (await call('GET', `${statusPath}/${encodeURIComponent(j.id)}`, tokenValue)).job || {};
    }
    if (j.status === 'success') return j;
    if (j.status === 'failed') {
      const code = j.error?.code;
      throw new CanvaError(`${what} failed. ${JOB_ERRORS[code] || j.error?.message || ''}`.trim(), { permanent: true, code });
    }
    throw new CanvaError(`${what} is taking too long in Canva. It will be tried again.`);
  }

  return {
    authUrl({ clientId, redirectUri, state, challenge }) {
      const u = new URL('https://www.canva.com/api/oauth/authorize');
      u.searchParams.set('code_challenge', challenge);
      u.searchParams.set('code_challenge_method', 's256');
      u.searchParams.set('scope', CANVA_SCOPES.join(' '));
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('state', state);
      u.searchParams.set('redirect_uri', redirectUri);
      return u.toString();
    },
    exchangeCode: ({ clientId, clientSecret, redirectUri, code, verifier }) =>
      token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, clientId, clientSecret),
    /** Refresh tokens are single-use: the caller must store the returned one. */
    refresh: ({ clientId, clientSecret, refreshToken }) =>
      token({ grant_type: 'refresh_token', refresh_token: refreshToken }, clientId, clientSecret),

    async account(tokenValue) {
      const me = await call('GET', '/users/me', tokenValue);
      let name = 'Canva account';
      try { name = (await call('GET', '/users/me/profile', tokenValue)).profile?.display_name || name; } catch { /* name is optional */ }
      let capabilities = [];
      try { capabilities = (await call('GET', '/users/me/capabilities', tokenValue)).capabilities || []; } catch { /* checked again when used */ }
      return { id: String(me.team_user?.user_id || ''), name, capabilities };
    },

    /** Brand templates that have data fields to fill. */
    async listTemplates(tokenValue) {
      const out = [];
      let continuation = '';
      for (let i = 0; i < 5; i++) {
        const q = new URLSearchParams({ dataset: 'non_empty', limit: '50' });
        if (continuation) q.set('continuation', continuation);
        const data = await call('GET', `/brand-templates?${q}`, tokenValue);
        for (const t of data.items || []) out.push({ id: String(t.id), title: t.title || 'Untitled template', thumbnail: t.thumbnail?.url || '' });
        continuation = data.continuation || '';
        if (!continuation) break;
      }
      return out;
    },

    /** { fieldName: 'image' | 'text' | ... } */
    async dataset(tokenValue, templateId) {
      const data = await call('GET', `/brand-templates/${encodeURIComponent(templateId)}/dataset`, tokenValue);
      return Object.fromEntries(Object.entries(data.dataset || {}).map(([k, v]) => [k, v?.type || 'text']));
    },

    /** Import a publicly reachable image into the user's Canva uploads. Returns the asset id. */
    async uploadFromUrl(tokenValue, name, url) {
      const j = await job(tokenValue, '/url-asset-uploads', { name: name.slice(0, 200), url }, '/url-asset-uploads', 'Sending the photo to Canva');
      if (!j.asset?.id) throw new CanvaError('Canva did not return the uploaded photo.');
      return String(j.asset.id);
    },

    /** Make a new design from a brand template. Returns { id, editUrl }. */
    async autofill(tokenValue, { templateId, title, data }) {
      const j = await job(tokenValue, '/autofills', { brand_template_id: templateId, title: title.slice(0, 250), data }, '/autofills', 'Filling the Canva template');
      const d = j.result?.design;
      if (!d?.id) throw new CanvaError('Canva did not return the new design.');
      return { id: String(d.id), editUrl: d.urls?.edit_url || d.url || '' };
    },

    /** Export page 1 of a design as a JPG and download it. */
    async exportJpg(tokenValue, designId) {
      const j = await job(tokenValue, '/exports', { design_id: designId, format: { type: 'jpg', quality: 92, pages: [1] } }, '/exports', 'Exporting the Canva design');
      const url = j.urls?.[0];
      if (!url) throw new CanvaError('Canva did not return the exported image.');
      let res;
      try { res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) }); } catch (e) { throw new CanvaError(`Could not download the Canva export: ${e.message}`); }
      if (!res.ok) throw new CanvaError(`Could not download the Canva export (HTTP ${res.status}).`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

/** What each template field can be filled with. */
export const FIELD_USES = {
  image: { photo: 'Generated photo', none: 'Leave as designed' },
  text: { headline: 'Headline', cta: 'Call to action', brand: 'Brand name', none: 'Leave as designed' },
};

/** Sensible starting choice for a field, from its name. */
export function guessUse(name, type, taken) {
  const n = name.toLowerCase();
  if (type === 'image') return taken.has('photo') ? 'none' : 'photo';
  if (type !== 'text') return 'none';
  if (/cta|button|action/.test(n) && !taken.has('cta')) return 'cta';
  if (/brand|company|name/.test(n) && !/head|title/.test(n) && !taken.has('brand')) return 'brand';
  if (!taken.has('headline')) return 'headline';
  return 'none';
}

/** Autofill data for a post from the saved field choices. */
export function autofillData(fields, { assetId, content, brandName }) {
  const data = {};
  for (const [name, f] of Object.entries(fields || {})) {
    if (f.type === 'image' && f.use === 'photo' && assetId) data[name] = { type: 'image', asset_id: assetId };
    else if (f.type === 'text' && f.use === 'headline') data[name] = { type: 'text', text: content.headline };
    else if (f.type === 'text' && f.use === 'cta') data[name] = { type: 'text', text: content.cta };
    else if (f.type === 'text' && f.use === 'brand') data[name] = { type: 'text', text: brandName };
  }
  return data;
}
