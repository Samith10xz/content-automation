import { encrypt, decrypt } from './security.js';
import { now } from './util.js';

// Keys whose values are secrets: stored encrypted, never shown again in the UI.
export const SECRET_KEYS = ['anthropic_api_key', 'slack_bot_token', 'slack_signing_secret', 'meta_app_secret'];

export function createSettings(db, secretKey) {
  return {
    async get(key) {
      const row = await db.get('SELECT svalue FROM settings WHERE skey = ?', [key]);
      if (!row || row.svalue == null || row.svalue === '') return '';
      if (!SECRET_KEYS.includes(key)) return row.svalue;
      try { return decrypt(row.svalue, secretKey); } catch { return ''; }
    },
    async set(key, value) {
      const stored = value && SECRET_KEYS.includes(key) ? encrypt(value, secretKey) : (value || '');
      const existing = await db.get('SELECT skey FROM settings WHERE skey = ?', [key]);
      if (existing) await db.run('UPDATE settings SET svalue = ?, updated_at = ? WHERE skey = ?', [stored, now(), key]);
      else await db.run('INSERT INTO settings (skey, svalue, updated_at) VALUES (?, ?, ?)', [key, stored, now()]);
    },
    async has(key) { return (await this.get(key)) !== ''; },
  };
}
