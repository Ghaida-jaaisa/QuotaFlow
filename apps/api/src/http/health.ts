import { Router } from 'express';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';

export function createHealthRouter(db: Database): Router {
  const router = Router();

  /** Liveness: the process is up and serving HTTP. Never touches the database. */
  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  /** Readiness: the database is reachable and migrations have created the schema. */
  router.get('/health/ready', async (req, res) => {
    try {
      await db.execute(sql`SELECT 1 FROM plans LIMIT 1`);
      res.json({ status: 'ok', database: 'ok' });
    } catch (error) {
      req.log.warn({ err: error }, 'readiness check failed');
      res.status(503).json({
        status: 'unavailable',
        database: 'unreachable',
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Database is not reachable or not migrated' },
      });
    }
  });

  return router;
}
