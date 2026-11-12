// Facebook Page and Instagram publishing through Meta's Graph API.
// Instagram uses "Instagram API with Facebook Login": the Instagram business account is linked
// to a Facebook Page and is published to with that Page's access token.
export const GRAPH_VERSION = 'v25.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'business_management',
  'instagram_basic',
  'instagram_content_publish',
];

// Graph error codes that mean "try again later" rather than "this will never work".
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613, 80001, 80002]);

export class MetaError extends Error {
  constructor(message, { permanent = false, code = null } = {}) {
    super(message);
    this.permanent = permanent;
    this.code = code;
  }
}

function explain(err, status) {
  const code = err?.code;
  const sub = err?.error_subcode;
  if (code === 190) return 'The Facebook connection has expired or was removed. Reconnect the brand to Facebook.';
  if (code === 10 || (code >= 200 && code < 300)) return `Facebook refused permission: ${err.message}. Reconnect the brand and allow every permission Facebook asks for.`;
  if (code === 36003 || sub === 2207009) return 'Instagram rejected the image shape. Use an image between 4:5 (portrait) and 1.91:1 (landscape).';
  if (sub === 2207026) return 'Instagram could not use the image. Upload a JPG under 8 MB.';
  if (code === 9 || sub === 2207042) return 'Instagram\'s daily publishing limit for this account was reached.';
  return err?.message ? `Meta: ${err.message}` : `Meta returned HTTP ${status}`;
}

export function createMeta({ fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 5000, pollTries = 6 } = {}) {
  async function graph(method, path, params = {}) {
    const url = new URL(`${GRAPH}/${path.replace(/^\//, '')}`);
    const init = { method, signal: AbortSignal.timeout(60_000) };
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    if (method === 'GET') for (const [k, v] of Object.entries(clean)) url.searchParams.set(k, String(v));
    else { init.headers = { 'content-type': 'application/x-www-form-urlencoded' }; init.body = new URLSearchParams(clean).toString(); }
    let res;
    try { res = await fetchImpl(url.toString(), init); } catch (e) { throw new MetaError(`Could not reach Facebook: ${e.message}`); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const e = data.error || {};
      const permanent = !(res.status >= 500 || TRANSIENT_CODES.has(e.code) || e.is_transient);
      throw new MetaError(explain(e, res.status), { permanent, code: e.code });
    }
    return data;
  }

  return {
    graph,

    authUrl({ appId, redirectUri, state, configId }) {
      const u = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
      u.searchParams.set('client_id', appId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      u.searchParams.set('response_type', 'code');
      if (configId) u.searchParams.set('config_id', configId);
      else u.searchParams.set('scope', META_SCOPES.join(','));
      return u.toString();
    },

    /** Code from the login redirect -> long-lived user token (about 60 days). */
    async exchangeCode({ appId, appSecret, redirectUri, code }) {
      const short = await graph('GET', 'oauth/access_token', { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code });
      const long = await graph('GET', 'oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token });
      return long.access_token || short.access_token;
    },

    /** Pages the user manages, each with a Page token (long-lived when made from a long-lived user token). */
    async listPages(userToken) {
      const out = [];
      let after = null;
      for (let i = 0; i < 10; i++) {
        const data = await graph('GET', 'me/accounts', {
          access_token: userToken, limit: 100, after,
          fields: 'id,name,access_token,instagram_business_account{id,username}',
        });
        for (const p of data.data || []) {
          out.push({
            id: String(p.id), name: p.name, token: p.access_token,
            igId: p.instagram_business_account?.id ? String(p.instagram_business_account.id) : null,
            igUsername: p.instagram_business_account?.username || null,
          });
        }
        after = data.paging?.cursors?.after;
        if (!data.paging?.next || !after) break;
      }
      return out;
    },

    /** Post to a Facebook Page: a photo post when there is an image, otherwise a text post. */
    async publishFacebook({ pageId, token, message, imageUrl }) {
      if (imageUrl) {
        const r = await graph('POST', `${pageId}/photos`, { url: imageUrl, caption: message, published: 'true', access_token: token });
        const postId = r.post_id || `${pageId}_${r.id}`;
        return { id: postId, url: `https://www.facebook.com/${postId}` };
      }
      const r = await graph('POST', `${pageId}/feed`, { message, access_token: token });
      return { id: r.id, url: `https://www.facebook.com/${r.id}` };
    },

    /**
     * Instagram: create a media container, wait until Instagram has fetched the image, publish.
     * `containerId` resumes a container made on an earlier attempt; `onContainer` saves a new one.
     */
    async publishInstagram({ igId, token, caption, imageUrl, containerId, onContainer = async () => {} }) {
      if (!imageUrl) throw new MetaError('Instagram needs an image. Upload one to the post.', { permanent: true });
      let id = containerId;
      if (!id) {
        const c = await graph('POST', `${igId}/media`, { image_url: imageUrl, caption, access_token: token });
        id = String(c.id);
        await onContainer(id);
      }
      for (let i = 0; i < pollTries; i++) {
        const s = await graph('GET', id, { fields: 'status_code,status', access_token: token });
        if (s.status_code === 'FINISHED') break;
        if (s.status_code === 'PUBLISHED') break;
        if (s.status_code === 'ERROR') {
          await onContainer(null);
          throw new MetaError(`Instagram could not process the image${s.status ? ` (${s.status})` : ''}. Check it is a JPG between 4:5 and 1.91:1.`, { permanent: true });
        }
        if (s.status_code === 'EXPIRED') {
          await onContainer(null);
          throw new MetaError('The Instagram upload expired before publishing. It will be tried again.');
        }
        if (i === pollTries - 1) throw new MetaError('Instagram is still processing the image. It will be tried again shortly.');
        await sleep(pollMs);
      }
      const pub = await graph('POST', `${igId}/media_publish`, { creation_id: id, access_token: token });
      let url = null;
      try { url = (await graph('GET', String(pub.id), { fields: 'permalink', access_token: token })).permalink || null; } catch { /* the post is live; the link is a nice-to-have */ }
      return { id: String(pub.id), url };
    },
  };
}
