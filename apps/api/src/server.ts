import { createApp } from './app.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { createDb, createPool } from './db/client.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX);
// An idle client erroring (e.g. Postgres restart) must not crash the process.
pool.on('error', (error) => logger.error({ err: error }, 'idle database client error'));

const db = createDb(pool);
const app = createApp({ db, clock: systemClock, adminToken: config.ADMIN_TOKEN }, logger);

if (!config.ADMIN_TOKEN) {
  logger.warn('ADMIN_TOKEN is not set: POST /v1/accounts is open (self-service provisioning)');
}

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'quotaflow api listening');
});
server.on('error', (error) => {
  logger.fatal({ err: error }, 'http server failed');
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down: draining connections');
  // Force exit if in-flight requests do not finish in time.
  const timer = setTimeout(() => {
    logger.error('graceful shutdown timed out');
    process.exit(1);
  }, 10_000);
  timer.unref();
  server.close((closeError) => {
    pool
      .end()
      .then(() => {
        logger.info('shutdown complete');
        process.exit(closeError ? 1 : 0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'error closing database pool');
        process.exit(1);
      });
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
