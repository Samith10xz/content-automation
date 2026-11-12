import crypto from 'node:crypto';
import { PLATFORMS, formatTime, safeEqual } from '../util.js';

/** Verify a request really came from Slack (signing secret + timestamp within 5 minutes). */
export function verifySlackSignature({ signingSecret, timestamp, signature, rawBody, nowSeconds = Date.now() / 1000 }) {
  if (!signingSecret || !timestamp || !signature) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
  return safeEqual(expected, signature);
}

async function call(method, token, body, fetchImpl) {
  const res = await fetchImpl(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error || `HTTP ${res.status}`}`);
  return data;
}

const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

function summaryBlocks(post, ws, appUrl) {
  const c = post.content;
  const image = post.image
    ? [{ type: 'image', image_url: post.image.url, alt_text: clip(c.headline || 'Post image', 1900) }]
    : [{ type: 'context', elements: [{ type: 'mrkdwn', text: post.platforms.includes('instagram') ? ':frame_with_picture: No image yet. Instagram needs one: add it in the dashboard before approving.' : ':frame_with_picture: No image yet.' }] }];
  const captions = post.platforms.map((p) => `*${PLATFORMS[p].label}*\n${clip(c.captions[p] || '', 600)}`).join('\n\n');
  const when = post.publish_at ? `scheduled ${formatTime(post.publish_at, ws.timezone)}` : 'publish when approved';
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*Post ready for review* · ${ws.name} · ${when}\nVersion ${post.version} · <${appUrl}/posts/${post.id}|Open in dashboard>` } },
    ...image,
    { type: 'section', text: { type: 'mrkdwn', text: clip(`*Headline:* ${c.headline}\n*Image idea:* ${c.image_prompt}`, 2900) } },
    { type: 'section', text: { type: 'mrkdwn', text: clip(captions, 2900) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: clip(c.hashtags.map((h) => `#${h}`).join(' ') || 'No hashtags', 2900) }] },
  ];
}

export function reviewBlocks(post, ws, appUrl) {
  return [
    ...summaryBlocks(post, ws, appUrl),
    {
      type: 'actions',
      block_id: 'review',
      elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: 'approve', value: String(post.id) },
        { type: 'button', text: { type: 'plain_text', text: 'Request changes' }, action_id: 'changes', value: String(post.id) },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: 'reject', value: String(post.id) },
      ],
    },
  ];
}

export function decidedBlocks(post, ws, appUrl, line) {
  return [...summaryBlocks(post, ws, appUrl), { type: 'context', elements: [{ type: 'mrkdwn', text: line }] }];
}

export function createSlack({ fetchImpl = fetch } = {}) {
  return {
    postReview: (token, channel, post, ws, appUrl) =>
      call('chat.postMessage', token, { channel, text: `Post ready for review: ${post.content.headline}`, blocks: reviewBlocks(post, ws, appUrl) }, fetchImpl),
    updateReview: (token, post, ws, appUrl) =>
      call('chat.update', token, { channel: post.slack_channel, ts: post.slack_ts, text: `Post ready for review: ${post.content.headline}`, blocks: reviewBlocks(post, ws, appUrl) }, fetchImpl),
    postThread: (token, channel, threadTs, text) =>
      call('chat.postMessage', token, { channel, thread_ts: threadTs, text, unfurl_links: false }, fetchImpl),
    markDecided: (token, post, ws, appUrl, line) =>
      call('chat.update', token, { channel: post.slack_channel, ts: post.slack_ts, text: line, blocks: decidedBlocks(post, ws, appUrl, line) }, fetchImpl),
    openChangesModal: (token, triggerId, postId) =>
      call('views.open', token, {
        trigger_id: triggerId,
        view: {
          type: 'modal', callback_id: 'changes_modal', private_metadata: String(postId),
          title: { type: 'plain_text', text: 'Request changes' },
          submit: { type: 'plain_text', text: 'Send' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [{
            type: 'input', block_id: 'note',
            label: { type: 'plain_text', text: 'What should change?' },
            element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 1500 },
          }],
        },
      }, fetchImpl),
    test: (token) => call('auth.test', token, {}, fetchImpl),
    /** Private reply to the person who clicked, via the interaction's response_url. */
    async respond(responseUrl, text) {
      if (!/^https:\/\/hooks\.slack\.com\//.test(String(responseUrl || ''))) return;
      await fetchImpl(responseUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    },
  };
}
