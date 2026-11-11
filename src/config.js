// All configuration comes from environment variables (see .env.example).
export function loadConfig(env = process.env) {
  const appUrl = (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return {
    port: env.PORT || 3000,
    appUrl,
    secure: appUrl.startsWith('https://'),
    db: {
      driver: env.DB_DRIVER || (env.DB_NAME ? 'mysql' : 'sqlite'),
      host: env.DB_HOST || '127.0.0.1',
      port: Number(env.DB_PORT || 3306),
      user: env.DB_USER || '',
      password: env.DB_PASSWORD || '',
      name: env.DB_NAME || '',
      sqlitePath: env.SQLITE_PATH || ':memory:',
    },
    secretKey: env.SECRET_KEY || '',
    setupToken: env.SETUP_TOKEN || '',
    cronSecret: env.CRON_SECRET || '',
  };
}
