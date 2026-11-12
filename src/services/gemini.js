// Image generation with Google's Gemini image models ("Nano Banana") through the Interactions API.
export const DEFAULT_IMAGE_MODEL = 'gemini-nano-banana-2.1';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Find the generated image in the response, whatever nesting the API used. Skips "thought" drafts. */
function findImage(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const item of node) { const hit = findImage(item, depth + 1); if (hit) return hit; }
    return null;
  }
  if (node.type === 'thought') return null;
  if (typeof node.data === 'string' && node.data.length > 200 && (node.type === 'image' || String(node.mime_type || '').startsWith('image/'))) return node.data;
  for (const key of ['output_image', 'outputs', 'steps', 'content', 'output']) {
    const hit = findImage(node[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

function explain(status, err) {
  const msg = err?.message || `HTTP ${status}`;
  if (status === 400 && /API key/i.test(msg)) return 'The Gemini API key is not valid. Check it under Settings.';
  if (status === 401 || status === 403) return `Gemini refused the request: ${msg}`;
  if (status === 404) return `Gemini does not know this image model. Check the model name under Settings. (${msg})`;
  if (status === 429) return 'Gemini\'s usage limit was reached. Check billing and quota in Google AI Studio, or try again later.';
  return `Gemini error: ${msg}`;
}

/**
 * Generate one image. `references` are images to work from (brand logo, previous version).
 * Returns the image bytes as a Buffer.
 */
export async function generateImage({ apiKey, model, prompt, references = [], aspectRatio = '4:5', imageSize = '1K', fetchImpl = fetch }) {
  if (!apiKey) throw Object.assign(new Error('Gemini API key is missing. Add it under Settings.'), { permanent: true });
  const input = [{ type: 'text', text: prompt }, ...references.map((r) => ({ type: 'image', mime_type: r.mime, data: r.data.toString('base64') }))];
  let res;
  try {
    res = await fetchImpl(`${BASE}/interactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model: model || DEFAULT_IMAGE_MODEL,
        input,
        response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: aspectRatio, image_size: imageSize },
      }),
      signal: AbortSignal.timeout(110_000),
    });
  } catch (e) { throw new Error(`Could not reach Gemini: ${e.message}`); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const permanent = [400, 401, 403, 404].includes(res.status);
    throw Object.assign(new Error(explain(res.status, data.error)), { permanent });
  }
  const b64 = findImage(data);
  if (!b64) throw new Error(`Gemini answered without an image (fields: ${Object.keys(data).slice(0, 8).join(', ') || 'none'}). The prompt may have been blocked.`);
  return Buffer.from(b64, 'base64');
}

/** Cheap check that the key and model name are accepted. */
export async function testGemini({ apiKey, model, fetchImpl = fetch }) {
  const res = await fetchImpl(`${BASE}/models/${encodeURIComponent(model || DEFAULT_IMAGE_MODEL)}`, {
    headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(explain(res.status, data.error));
  return data.displayName || data.name || model;
}

/** The instruction given to the image model for a post. */
export function imagePrompt({ brand, content, hasLogo, editNote }) {
  const lines = editNote ? [
    'Edit the attached social media ad image. Keep everything the same except for the requested changes.',
    `Requested changes: ${editNote}`,
    `The headline text on the image must read exactly: "${content.headline}"`,
  ] : [
    `Create a finished social media ad image for the brand "${brand.name}".`,
    `Visual: ${content.image_prompt}`,
    `Put this headline on the image as large, clean, easy-to-read text, spelled exactly: "${content.headline}"`,
    `Use the brand colours ${brand.primary_color} and ${brand.secondary_color} for the text, shapes and accents.`,
  ];
  if (editNote) lines.push('Keep any logo exactly as it is.');
  else lines.push(hasLogo
    ? 'Place the attached brand logo small in one corner. Reproduce the logo exactly as given; do not redraw or alter it.'
    : 'Do not add any logo or brand mark.');
  lines.push('No other text, no hashtags, no watermark, no borders. Leave comfortable margins so nothing is cropped.');
  return lines.join('\n');
}
