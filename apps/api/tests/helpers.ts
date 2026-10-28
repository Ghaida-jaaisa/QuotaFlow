import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type pg from 'pg';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import type { Clock } from '../src/clock.js';
import { createDb, createPool, type Database } from '../src/db/client.js';
import { createLogger } from '../src/logger.js';

/** A clock tests can move, e.g. across a UTC month boundary. */
export class TestClock implements Clock {
  constructor(private current: Date = new Date()) {}
  now(): Date {
    return new Date(this.current);
  }
  set(instant: Date | string): void {
    this.current = new Date(instant);
  }
}

export interface TestContext {
  /** Supertest agent bound to a real listening HTTP server. */
  http: ReturnType<typeof request>;
  server: Server;
  db: Database;
  pool: pg.Pool;
  clock: Clock;
  close(): Promise<void>;
}

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  return url;
}

export async function createTestContext(
  options: { clock?: Clock; adminToken?: string; poolMax?: number; logStream?: NodeJS.WritableStream & { write(msg: string): unknown } } = {},
): Promise<TestContext> {
  const pool = createPool(testDatabaseUrl(), options.poolMax ?? 10);
  const db = createDb(pool);
  const clock = options.clock ?? { now: () => new Date() };
  // Same logger configuration (including redaction) as production.
  const logger = options.logStream ? createLogger('debug', options.logStream) : createLogger('silent');
  const app = createApp({ db, clock, adminToken: options.adminToken }, logger);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  return {
    http: request(`http://127.0.0.1:${port}`),
    server,
    db,
    pool,
    clock,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}

let counter = 0;
/** Unique, readable request IDs so tests never collide across runs or files. */
export function uniqueId(prefix = 'req'): string {
  counter += 1;
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${counter}`;
}

export interface TestAccount {
  id: string;
  apiKey: string;
  planId: string;
}

export async function predefinedPlanId(ctx: TestContext, code: 'starter' | 'pro' | 'basic' | 'premium'): Promise<string> {
  const res = await ctx.http.get('/v1/plans/predefined').expect(200);
  const plan = (res.body.data as Array<{ id: string; code: string }>).find((p) => p.code === code);
  if (!plan) throw new Error(`predefined plan ${code} missing`);
  return plan.id;
}

export async function createAccount(ctx: TestContext, name = 'Test account', planId?: string): Promise<TestAccount> {
  const res = await ctx.http
    .post('/v1/accounts')
    .send({ name, ...(planId ? { planId } : {}) })
    .expect(201);
  return { id: res.body.id, apiKey: res.body.apiKey, planId: res.body.plan.id };
}

export async function createCustomPlan(
  ctx: TestContext,
  account: TestAccount,
  plan: { scope: 'account' | 'user'; monthlyLimit: number; perRequestLimit: number; name?: string },
): Promise<string> {
  const res = await ctx.http
    .post('/v1/plans')
    .set('X-API-Key', account.apiKey)
    .send({ name: plan.name ?? uniqueId(`${plan.scope}-plan`), ...plan })
    .expect(201);
  return res.body.id;
}

export async function assignAccountPlan(ctx: TestContext, account: TestAccount, planId: string): Promise<void> {
  await ctx.http.put('/v1/account/plan').set('X-API-Key', account.apiKey).send({ planId }).expect(200);
}

export async function createUser(ctx: TestContext, account: TestAccount, planId?: string, name = 'user'): Promise<string> {
  const res = await ctx.http
    .post('/v1/users')
    .set('X-API-Key', account.apiKey)
    .send({ name, ...(planId ? { planId } : {}) })
    .expect(201);
  return res.body.id;
}

export function consume(ctx: TestContext, account: TestAccount, userId: string, units: number, requestId = uniqueId()) {
  return ctx.http.post('/v1/usage/consume').set('X-API-Key', account.apiKey).send({ userId, units, requestId });
}

/**
 * Account with custom plans of the given limits and N users on one shared
 * custom user plan: the standard fixture for rule tests.
 */
export async function setupScenario(
  ctx: TestContext,
  limits: {
    account: { monthlyLimit: number; perRequestLimit: number };
    user: { monthlyLimit: number; perRequestLimit: number };
  },
  userCount = 1,
): Promise<{ account: TestAccount; accountPlanId: string; userPlanId: string; userIds: string[] }> {
  const account = await createAccount(ctx);
  const accountPlanId = await createCustomPlan(ctx, account, { scope: 'account', ...limits.account });
  await assignAccountPlan(ctx, account, accountPlanId);
  const userPlanId = await createCustomPlan(ctx, account, { scope: 'user', ...limits.user });
  const userIds: string[] = [];
  for (let i = 0; i < userCount; i++) {
    userIds.push(await createUser(ctx, account, userPlanId, `user-${i}`));
  }
  return { account, accountPlanId, userPlanId, userIds };
}

const levelSchema = z.strictObject({
  planId: z.uuid(),
  planVersion: z.number().int().positive(),
  monthlyLimit: z.number().int().positive(),
  perRequestLimit: z.number().int().positive(),
  usedUnits: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});

/** Contract of the consumption response; used to validate response shapes in tests. */
export const decisionResponseSchema = z.strictObject({
  id: z.uuid(),
  requestId: z.string(),
  decision: z.enum(['accepted', 'rejected']),
  userId: z.uuid(),
  units: z.number().int().positive(),
  unitsAccepted: z.number().int().nonnegative(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  processedAt: z.iso.datetime(),
  rejection: z
    .strictObject({
      code: z.enum([
        'ACCOUNT_PER_REQUEST_LIMIT_EXCEEDED',
        'USER_PER_REQUEST_LIMIT_EXCEEDED',
        'ACCOUNT_MONTHLY_LIMIT_EXCEEDED',
        'USER_MONTHLY_LIMIT_EXCEEDED',
      ]),
      level: z.enum(['account', 'user']),
      limitType: z.enum(['per_request', 'monthly']),
      limit: z.number().int().positive(),
      available: z.number().int().nonnegative().nullable(),
      message: z.string().min(1),
    })
    .nullable(),
  account: levelSchema,
  user: levelSchema,
  replayed: z.boolean(),
});

export type DecisionResponse = z.infer<typeof decisionResponseSchema>;

export const errorResponseSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

/** Reads counters straight from the database to cross-check API-reported values. */
export async function readCounters(ctx: TestContext, accountId: string, month: string) {
  const result = await ctx.pool.query<{
    account_used: number | null;
    users_sum: string | null;
    accepted_sum: string | null;
  }>(
    `SELECT
       (SELECT used_units FROM account_monthly_usage WHERE account_id = $1 AND month = $2::date) AS account_used,
       (SELECT SUM(used_units) FROM user_monthly_usage WHERE account_id = $1 AND month = $2::date) AS users_sum,
       (SELECT SUM(units) FROM usage_requests WHERE account_id = $1 AND usage_month = $2::date AND status = 'accepted') AS accepted_sum`,
    [accountId, `${month}-01`],
  );
  const row = result.rows[0]!;
  return {
    accountUsed: row.account_used ?? 0,
    usersSum: Number(row.users_sum ?? 0),
    acceptedSum: Number(row.accepted_sum ?? 0),
  };
}

/**
 * Runs tasks with at most `limit` in flight. Bursts of hundreds of simultaneous
 * sockets overflow the OS listen backlog (128 on macOS) and fail with
 * ECONNRESET before reaching the app; 50 in flight still far exceeds the DB
 * pool, so transactions genuinely contend on the usage row locks.
 */
export async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit = 50): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
