// Entry point. Hostinger starts this file and passes the port in PORT.
import http from 'node:http';
import { loadConfig } from './src/config.js';
import { openDb } from './src/db/index.js';
import { createApp } from './src/app.js';

const config = loadConfig();
let app = null;
let problem = 'starting';

async function boot() {
  try {
    if (config.db.driver === 'mysql' && !config.secretKey) throw new Error('SECRET_KEY is not set');
    const db = await openDb(config.db);
    app = createApp({ db, config });
    problem = '';
    console.log(`database ready (${db.dialect})`);
    app.engine.kick(); // pick up anything left over from before a restart
  } catch (err) {
    // Keep serving a clear status instead of crashing, and try again shortly.
    problem = err.code || err.message;
    console.error('startup failed:', err.message);
    setTimeout(() => { booting = boot(); }, 15_000);
  }
}

const server = http.createServer(async (req, res) => {
  // The host starts this process on the first request after idle: let that request
  // wait for the database connection instead of answering "starting".
  if (!app) await booting;
  if (app) return app.handle(req, res);
  const body = req.url === '/health'
    ? JSON.stringify({ ok: false, db: false, problem })
    : 'Content Pipeline is starting or its database is not reachable. Check /health.';
  res.writeHead(503, { 'content-type': req.url === '/health' ? 'application/json' : 'text/plain; charset=utf-8', 'retry-after': '15' });
  res.end(body);
});

let booting = boot();
server.listen(config.port, () => console.log(`listening on ${config.port}`));
