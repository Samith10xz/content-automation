import { migrations } from './schema.js';

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

async function openSqlite(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path);
  return {
    dialect: 'sqlite',
    async all(sql, p = []) { return d.prepare(sql).all(...p.map(norm)); },
    async get(sql, p = []) { return d.prepare(sql).get(...p.map(norm)); },
    async run(sql, p = []) {
      const r = d.prepare(sql).run(...p.map(norm));
      return { insertId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    async close() { d.close(); },
  };
}

async function openMysql(cfg) {
  const mysql = (await import('mysql2/promise')).default;
  const pool = mysql.createPool({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.name,
    waitForConnections: true, connectionLimit: 5, charset: 'utf8mb4', timezone: 'Z', dateStrings: true,
  });
  return {
    dialect: 'mysql',
    async all(sql, p = []) { const [rows] = await pool.query(sql, p.map(norm)); return rows; },
    async get(sql, p = []) { const [rows] = await pool.query(sql, p.map(norm)); return rows[0]; },
    async run(sql, p = []) {
      const [r] = await pool.query(sql, p.map(norm));
      return { insertId: Number(r.insertId || 0), changes: Number(r.affectedRows || 0) };
    },
    async close() { await pool.end(); },
  };
}

export async function openDb(cfg) {
  const db = cfg.driver === 'mysql' ? await openMysql(cfg) : await openSqlite(cfg.sqlitePath);
  await migrate(db);
  return db;
}

const TYPES = {
  sqlite: { PK: 'INTEGER PRIMARY KEY AUTOINCREMENT', TEXT: 'TEXT', DT: 'VARCHAR(19)', END: '' },
  mysql: { PK: 'BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY', TEXT: 'LONGTEXT', DT: 'DATETIME', END: ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' },
};

/** Run each numbered migration once. Statements use {{PK}}, {{TEXT}}, {{DT}}, {{END}} placeholders. */
export async function migrate(db) {
  const t = TYPES[db.dialect];
  const render = (sql) => sql.replace(/\{\{(\w+)\}\}/g, (_, k) => t[k]);
  await db.run(render('CREATE TABLE IF NOT EXISTS migrations (version INT PRIMARY KEY, applied_at {{DT}}){{END}}'));
  const done = new Set((await db.all('SELECT version FROM migrations')).map((r) => Number(r.version)));
  for (const [i, statements] of migrations.entries()) {
    const version = i + 1;
    if (done.has(version)) continue;
    for (const sql of statements) {
      try {
        await db.run(render(sql));
      } catch (err) {
        // A half-applied migration is re-run safely: skip indexes that already exist.
        if (!/already exists|Duplicate key name/i.test(err.message)) throw err;
      }
    }
    await db.run('INSERT INTO migrations (version, applied_at) VALUES (?, ?)',
      [version, new Date().toISOString().slice(0, 19).replace('T', ' ')]);
  }
}
