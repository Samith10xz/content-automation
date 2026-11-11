import { PLATFORMS } from '../util.js';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

const PLATFORM_GUIDE = {
  facebook: 'Facebook: friendly and clear, 40-90 words, one call to action.',
  instagram: 'Instagram: hook in the first line, 40-100 words, line breaks for rhythm. Hashtags are supplied separately, do not put them in the caption.',
  linkedin: 'LinkedIn: professional and specific, 60-120 words, no hype.',
  tiktok: 'TikTok: short and punchy, under 30 words.',
  x: 'X: at most 260 characters including spaces.',
};

function systemPrompt(ws) {
  const lines = [
    `You write social media posts for the brand "${ws.name}".`,
    ws.tone ? `Tone of voice: ${ws.tone}` : '',
    ws.audience ? `Audience: ${ws.audience}` : '',
    ws.banned_words ? `Never use these words or phrases: ${ws.banned_words}` : '',
    ws.sample_posts ? `Examples of posts the brand likes:\n${ws.sample_posts}` : '',
    'Only state facts given in the brief. Do not invent prices, dates, offers, statistics or claims.',
    'Save your work by calling the save_post tool exactly once.',
  ];
  return lines.filter(Boolean).join('\n\n');
}

function userPrompt({ brief, platforms, previous, note }) {
  const parts = [
    `Brief\nGoal: ${brief.goal}`,
    brief.details ? `Details and offer: ${brief.details}` : '',
    `Language: ${brief.language || 'English'}`,
    `Write one caption for each of these platforms:\n${platforms.map((p) => `- ${PLATFORM_GUIDE[p]}`).join('\n')}`,
    'Also write: a headline of at most 8 words to place on the image, an image prompt describing the visual (no text in the image), 5-8 hashtags without the # sign, and a short call to action.',
  ];
  if (previous && note) {
    parts.push(`This is a revision. The previous version was:\n${JSON.stringify(previous, null, 2)}`);
    parts.push(`The reviewer asked for these changes:\n${note}\n\nApply the changes and keep everything the reviewer did not mention.`);
  }
  return parts.filter(Boolean).join('\n\n');
}

function tool(platforms) {
  const captions = Object.fromEntries(platforms.map((p) => [p, { type: 'string', description: `Caption for ${PLATFORMS[p].label}` }]));
  return {
    name: 'save_post',
    description: 'Save the finished social media post.',
    input_schema: {
      type: 'object',
      properties: {
        headline: { type: 'string' },
        image_prompt: { type: 'string' },
        captions: { type: 'object', properties: captions, required: platforms },
        hashtags: { type: 'array', items: { type: 'string' } },
        cta: { type: 'string' },
      },
      required: ['headline', 'image_prompt', 'captions', 'hashtags', 'cta'],
    },
  };
}

/** Ask Claude for the post content. Returns { content, usage, model }. */
export async function generateContent({ apiKey, model, workspace, brief, platforms, previous, note, fetchImpl = fetch }) {
  if (!apiKey) throw Object.assign(new Error('Claude API key is missing. Add it under Settings.'), { permanent: true });
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 2000,
      system: systemPrompt(workspace),
      tools: [tool(platforms)],
      tool_choice: { type: 'tool', name: 'save_post' },
      messages: [{ role: 'user', content: userPrompt({ brief, platforms, previous, note }) }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `HTTP ${res.status}`;
    // Bad key, bad model name or bad request will not fix themselves: do not retry.
    const permanent = [400, 401, 403, 404].includes(res.status);
    throw Object.assign(new Error(`Claude API error: ${message}`), { permanent });
  }
  const block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'save_post');
  if (!block) throw new Error('Claude did not return a post.');
  const input = block.input || {};
  const content = {
    headline: String(input.headline || '').trim(),
    image_prompt: String(input.image_prompt || '').trim(),
    captions: Object.fromEntries(platforms.map((p) => [p, String(input.captions?.[p] || '').trim()])),
    hashtags: (Array.isArray(input.hashtags) ? input.hashtags : []).map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean),
    cta: String(input.cta || '').trim(),
  };
  const missing = platforms.filter((p) => !content.captions[p]);
  if (!content.headline || missing.length) throw new Error(`Claude returned an incomplete post (missing: ${['headline'].filter(() => !content.headline).concat(missing).join(', ')}).`);
  return {
    content,
    model: data.model || model || DEFAULT_MODEL,
    usage: { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 },
  };
}

/** Cheapest possible call to confirm the key and model name work. */
export async function testClaude({ apiKey, model, fetchImpl = fetch }) {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model || DEFAULT_MODEL, max_tokens: 5, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data.model || model;
}
