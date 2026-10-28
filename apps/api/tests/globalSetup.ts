import pg from 'pg';
import { migrateAndSeed } from '../src/db/migrate.js';

/**
 * Runs once before all test files: creates the test database if needed,
 * applies migrations, wipes previous data and re-seeds predefined plans.
 * Individual tests then isolate themselves by creating fresh accounts.
 */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env and start Postgres (docker compose up -d postgres), ' +
        'or export TEST_DATABASE_URL=postgres://user:pass@host:port/quotaflow_test',
    );
  }
  await ensureDatabaseExists(url);
  await migrateAndSeed(url);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      'TRUNCATE usage_requests, user_monthly_usage, account_monthly_usage, users, accounts, plans RESTART IDENTITY CASCADE',
    );
  } finally {
    await client.end();
  }
  // Truncation removed the predefined plans too; seeding is idempotent.
  await migrateAndSeed(url);
}

async function ensureDatabaseExists(url: string): Promise<void> {
  const target = new URL(url);
  const databaseName = decodeURIComponent(target.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new Error(`Refusing to create test database with unusual name "${databaseName}"`);
  }
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE "${databaseName}"`);
    }
  } finally {
    await client.end();
  }
}
