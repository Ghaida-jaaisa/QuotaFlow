import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run queries: the pool-backed db or an open transaction. */
export type Executor = Database | Transaction;

export function createPool(connectionString: string, max: number): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Guards against a stuck lock wait holding a pooled connection forever.
    statement_timeout: 10_000,
    application_name: 'quotaflow-api',
  });
}

export function createDb(pool: pg.Pool): Database {
  return drizzle({ client: pool, schema });
}
