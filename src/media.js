// Images attached to posts. Stored in the database so they survive redeploys, and served at
// an unguessable public URL because Facebook and Instagram fetch the image themselves.
import { now, randomToken } from './util.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IG_MIN_RATIO = 4 / 5;
export const IG_MAX_RATIO = 1.91;

/** Width and height of a baseline or progressive JPEG, or null if the bytes are not a JPEG. */
export function jpegInfo(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

export const isPng = (buf) => buf?.length > 8 && buf.readUInt32BE(0) === 0x89504e47;

/** Why this image can't go to Instagram, or '' if it can. */
export function instagramProblem(image) {
  if (!image) return 'Instagram needs an image. Upload one before approving.';
  const ratio = image.width / image.height;
  if (ratio < IG_MIN_RATIO - 0.005 || ratio > IG_MAX_RATIO + 0.005) {
    return `Instagram only accepts images between 4:5 (portrait) and 1.91:1 (landscape). This one is ${image.width}×${image.height}. Export a 1080×1080 or 1080×1350 JPG.`;
  }
  return '';
}

export function createMedia(db, appUrl) {
  const toImage = (row) => row && {
    id: row.id, token: row.token, width: Number(row.width), height: Number(row.height), size: Number(row.size),
    url: `${appUrl}/media/${row.token}.jpg`,
  };
  return {
    toImage,
    async forPost(post) {
      if (!post?.image_id) return null;
      return toImage(await db.get('SELECT id, token, width, height, size FROM media WHERE id = ?', [post.image_id]));
    },
    /** Validate and store an uploaded JPEG. Throws an Error with a reader-facing message. */
    async save(postId, buf) {
      if (!buf?.length) throw new Error('Choose an image file to upload.');
      if (buf.length > MAX_IMAGE_BYTES) throw new Error('That image is over 8 MB. Export it smaller and try again.');
      if (isPng(buf)) throw new Error('That is a PNG. Instagram only accepts JPG, so export the design from Canva as JPG.');
      const info = jpegInfo(buf);
      if (!info || !info.width || !info.height) throw new Error('That file is not a JPG image. Export the design as JPG and try again.');
      const token = randomToken(24);
      const { insertId } = await db.run(
        'INSERT INTO media (post_id, token, mime, width, height, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [postId, token, 'image/jpeg', info.width, info.height, buf.length, buf, now()]);
      return { id: insertId, ...info };
    },
    async read(token) {
      if (!/^[a-f0-9]{48}$/.test(token)) return null;
      const row = await db.get('SELECT mime, data FROM media WHERE token = ?', [token]);
      if (!row) return null;
      return { mime: row.mime, data: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data) };
    },
  };
}
