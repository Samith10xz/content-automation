import crypto from 'node:crypto';

export const PLATFORMS = {
  facebook: { label: 'Facebook', limit: 2000 },
  instagram: { label: 'Instagram', limit: 2200 },
  linkedin: { label: 'LinkedIn', limit: 3000 },
  tiktok: { label: 'TikTok', limit: 2200 },
  x: { label: 'X', limit: 280 },
};

export const STATUS_LABELS = {
  generating: 'Generating',
  in_review: 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
  failed: 'Failed',
  scheduled: 'Scheduled',
  published: 'Published',
};

export const MAX_VERSIONS = 4; // first draft + 3 rounds of changes

/** UTC timestamp as 'YYYY-MM-DD HH:MM:SS' (sorts and compares as text in MySQL and SQLite). */
export function now(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function parseJson(text, fallback = null) {
  try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
}

/** Offset in ms of a time zone at a given UTC instant. */
function tzOffset(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/** '2026-11-20T18:30' entered in a time zone -> UTC 'YYYY-MM-DD HH:MM:SS', or null if invalid. */
export function localToUtc(local, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const utc = guess - tzOffset(guess, timeZone);
  return new Date(utc).toISOString().slice(0, 19).replace('T', ' ');
}

/** UTC 'YYYY-MM-DD HH:MM:SS' -> readable time in a time zone. */
export function formatTime(utc, timeZone = 'Asia/Colombo') {
  if (!utc) return '';
  const d = new Date(String(utc).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
}

export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
