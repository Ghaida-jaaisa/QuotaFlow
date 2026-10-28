import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createDb, createPool } from './client.js';
import { seedPredefinedPlans } from './seed.js';

// Works from both src/db (tsx) and dist/db (compiled): migrations live in <app>/drizzle.
const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/** Applies pending migrations, then seeds predefined plans. Safe to run repeatedly. */
export async function migrateAndSeed(connectionString: string): Promise<{ seededPlans: number }> {
  const pool = createPool(connectionString, 2);
  try {
    const db = createDb(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const seededPlans = await seedPredefinedPlans(db);
    return { seededPlans };
  } finally {
    await pool.end();
  }
}

const isEntryPoint = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  migrateAndSeed(config.DATABASE_URL)
    .then(({ seededPlans }) => {
      logger.info({ seededPlans }, 'migrations applied and predefined plans seeded');
    })
    .catch((error: unknown) => {
      logger.fatal({ err: error }, 'database initialization failed');
      process.exitCode = 1;
    });
}
