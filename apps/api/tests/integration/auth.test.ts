import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consume,
  createAccount,
  createCustomPlan,
  createTestContext,
  createUser,
  errorResponseSchema,
  type TestAccount,
  type TestContext,
} from '../helpers.js';

let ctx: TestContext;
let accountA: TestAccount;
let accountB: TestAccount;
let userOfB: string;
let userPlanOfB: string;
let accountPlanOfB: string;

beforeAll(async () => {
  ctx = await createTestContext();
  accountA = await createAccount(ctx, 'Account A');
  accountB = await createAccount(ctx, 'Account B');
  userOfB = await createUser(ctx, accountB);
  userPlanOfB = await createCustomPlan(ctx, accountB, { scope: 'user', monthlyLimit: 100, perRequestLimit: 10 });
  accountPlanOfB = await createCustomPlan(ctx, accountB, { scope: 'account', monthlyLimit: 100, perRequestLimit: 10 });
});
afterAll(() => ctx.close());

describe('API key authentication', () => {
  it('rejects a missing API key with 401 MISSING_API_KEY', async () => {
    const res = await ctx.http.get('/v1/account').expect(401);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('MISSING_API_KEY');
  });

  it('rejects malformed and unknown keys identically with 401 INVALID_API_KEY', async () => {
    const malformed = await ctx.http.get('/v1/account').set('X-API-Key', 'definitely-not-a-key').expect(401);
    const unknown = await ctx.http
      .get('/v1/account')
      .set('X-API-Key', `qf_${'A'.repeat(43)}`)
      .expect(401);
    expect(malformed.body).toEqual(unknown.body);
    expect(malformed.body.error.code).toBe('INVALID_API_KEY');
  });

  it('authenticates the account from its key and returns only that account', async () => {
    const res = await ctx.http.get('/v1/account').set('X-API-Key', accountA.apiKey).expect(200);
    expect(res.body.id).toBe(accountA.id);
    expect(res.body.name).toBe('Account A');
    expect(res.body).not.toHaveProperty('apiKey');
    expect(res.body).not.toHaveProperty('apiKeyHash');
    expect(accountA.apiKey.startsWith(res.body.apiKeyPrefix)).toBe(true);
  });

  it('protects every account-scoped route', async () => {
    const routes: Array<[method: 'get' | 'post' | 'put' | 'patch', path: string]> = [
      ['get', '/v1/account'],
      ['put', '/v1/account/plan'],
      ['get', '/v1/account/usage'],
      ['get', '/v1/account/usage/monthly'],
      ['get', '/v1/users'],
      ['post', '/v1/users'],
      ['get', `/v1/users/${userOfB}`],
      ['put', `/v1/users/${userOfB}/plan`],
      ['get', `/v1/users/${userOfB}/usage`],
      ['get', `/v1/users/${userOfB}/usage/monthly`],
      ['get', '/v1/plans'],
      ['post', '/v1/plans'],
      ['get', `/v1/plans/${userPlanOfB}`],
      ['patch', `/v1/plans/${userPlanOfB}`],
      ['post', '/v1/usage/consume'],
      ['get', '/v1/usage/requests'],
    ];
    for (const [method, path] of routes) {
      const res = await ctx.http[method](path).send({});
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });

  it('ignores account identifiers supplied by the caller', async () => {
    // A body field naming another account must not change who is acting.
    const res = await ctx.http
      .post('/v1/users')
      .set('X-API-Key', accountA.apiKey)
      .send({ name: 'sneaky', accountId: accountB.id })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('account isolation', () => {
  it("returns 404 for another account's user on every user route", async () => {
    const key = accountA.apiKey;
    const checks = [
      ctx.http.get(`/v1/users/${userOfB}`).set('X-API-Key', key),
      ctx.http.get(`/v1/users/${userOfB}/usage`).set('X-API-Key', key),
      ctx.http.get(`/v1/users/${userOfB}/usage/monthly`).set('X-API-Key', key),
      ctx.http.put(`/v1/users/${userOfB}/plan`).set('X-API-Key', key).send({ planId: userPlanOfB }),
      ctx.http.get(`/v1/usage/requests?userId=${userOfB}`).set('X-API-Key', key),
    ];
    for (const res of await Promise.all(checks)) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('USER_NOT_FOUND');
    }
  });

  it("cannot consume on behalf of another account's user, and nothing is recorded", async () => {
    const res = await consume(ctx, accountA, userOfB, 1, 'cross-account-attempt').expect(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
    const recorded = await ctx.pool.query('SELECT 1 FROM usage_requests WHERE request_id = $1', ['cross-account-attempt']);
    expect(recorded.rowCount).toBe(0);
  });

  it("reports another account's user exactly like a nonexistent one", async () => {
    const foreign = await ctx.http.get(`/v1/users/${userOfB}`).set('X-API-Key', accountA.apiKey);
    const missing = await ctx.http.get(`/v1/users/${crypto.randomUUID()}`).set('X-API-Key', accountA.apiKey);
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
  });

  it("cannot read, update or assign another account's custom plans", async () => {
    const key = accountA.apiKey;
    const read = await ctx.http.get(`/v1/plans/${userPlanOfB}`).set('X-API-Key', key);
    const update = await ctx.http.patch(`/v1/plans/${userPlanOfB}`).set('X-API-Key', key).send({ monthlyLimit: 1 });
    const userA = await createUser(ctx, accountA);
    const assignUser = await ctx.http.put(`/v1/users/${userA}/plan`).set('X-API-Key', key).send({ planId: userPlanOfB });
    const assignAccount = await ctx.http.put('/v1/account/plan').set('X-API-Key', key).send({ planId: accountPlanOfB });
    const createWith = await ctx.http.post('/v1/users').set('X-API-Key', key).send({ name: 'x', planId: userPlanOfB });
    for (const res of [read, update, assignUser, assignAccount, createWith]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PLAN_NOT_FOUND');
    }
    // The foreign plan is untouched.
    const own = await ctx.http.get(`/v1/plans/${userPlanOfB}`).set('X-API-Key', accountB.apiKey).expect(200);
    expect(own.body.monthlyLimit).toBe(100);
    expect(own.body.version).toBe(1);
  });

  it("does not list another account's custom plans", async () => {
    const res = await ctx.http.get('/v1/plans?kind=custom').set('X-API-Key', accountA.apiKey).expect(200);
    const ids = (res.body.data as Array<{ id: string }>).map((p) => p.id);
    expect(ids).not.toContain(userPlanOfB);
    expect(ids).not.toContain(accountPlanOfB);
  });

  it("does not show another account's request history", async () => {
    await consume(ctx, accountB, userOfB, 1).expect(200);
    const res = await ctx.http.get('/v1/usage/requests').set('X-API-Key', accountA.apiKey).expect(200);
    expect((res.body.data as Array<{ userId: string }>).every((r) => r.userId !== userOfB)).toBe(true);
  });
});

describe('input validation', () => {
  it('rejects malformed UUIDs in paths and bodies with 400', async () => {
    const path = await ctx.http.get('/v1/users/not-a-uuid').set('X-API-Key', accountA.apiKey).expect(400);
    expect(path.body.error.code).toBe('VALIDATION_ERROR');
    expect(path.body.error.details[0].path).toBe('userId');
    const body = await consume(ctx, accountA, 'not-a-uuid', 1).expect(400);
    expect(body.body.error.details[0].path).toBe('userId');
  });

  it('rejects invalid JSON with 400 INVALID_JSON', async () => {
    const res = await ctx.http
      .post('/v1/users')
      .set('X-API-Key', accountA.apiKey)
      .set('Content-Type', 'application/json')
      .send('{"name": ')
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await ctx.http
      .post('/v1/users')
      .set('X-API-Key', accountA.apiKey)
      .send({ name: 'x'.repeat(20_000) })
      .expect(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns structured 404 for unknown routes', async () => {
    const res = await ctx.http.get('/does-not-exist').expect(404);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('NOT_FOUND');
  });
});

describe('account provisioning', () => {
  it('returns the API key once, on creation only', async () => {
    const res = await ctx.http.post('/v1/accounts').send({ name: 'Once' }).expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.apiKey).toMatch(/^qf_[A-Za-z0-9_-]{43}$/);
    expect(res.body.plan.code).toBe('starter');
    const stored = await ctx.pool.query<{ api_key_hash: string }>('SELECT api_key_hash FROM accounts WHERE id = $1', [res.body.id]);
    expect(stored.rows[0]!.api_key_hash).not.toContain(res.body.apiKey);
  });

  it('rejects a user plan as the initial account plan', async () => {
    const plans = await ctx.http.get('/v1/plans/predefined?scope=user').expect(200);
    const res = await ctx.http.post('/v1/accounts').send({ name: 'x', planId: plans.body.data[0].id }).expect(422);
    expect(res.body.error.code).toBe('PLAN_SCOPE_MISMATCH');
  });

  it('requires the admin token when ADMIN_TOKEN is configured', async () => {
    const gated = await createTestContext({ adminToken: 'admin-token-for-tests-123' });
    try {
      expect((await gated.http.post('/v1/accounts').send({ name: 'x' }).expect(401)).body.error.code).toBe('MISSING_ADMIN_TOKEN');
      const wrong = await gated.http.post('/v1/accounts').set('X-Admin-Token', 'wrong').send({ name: 'x' }).expect(403);
      expect(wrong.body.error.code).toBe('INVALID_ADMIN_TOKEN');
      await gated.http
        .post('/v1/accounts')
        .set('X-Admin-Token', 'admin-token-for-tests-123')
        .send({ name: 'Gated' })
        .expect(201);
    } finally {
      await gated.close();
    }
  });
});

describe('logging', () => {
  it('never writes API keys or admin tokens to logs', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logged = await createTestContext({ logStream: stream, adminToken: 'admin-token-secret-xyz' });
    try {
      const created = await logged.http
        .post('/v1/accounts')
        .set('X-Admin-Token', 'admin-token-secret-xyz')
        .send({ name: 'Logged' })
        .expect(201);
      const key: string = created.body.apiKey;
      await logged.http.get('/v1/account').set('X-API-Key', key).expect(200);
      await logged.http.get('/v1/account').set('X-API-Key', `${key.slice(0, -1)}x`).expect(401);
      const output = lines.join('');
      expect(output).toContain('[REDACTED]');
      expect(output).not.toContain(key);
      expect(output).not.toContain(key.slice(3));
      expect(output).not.toContain('admin-token-secret-xyz');
    } finally {
      await logged.close();
    }
  });
});

describe('health', () => {
  it('reports liveness and database readiness', async () => {
    expect((await ctx.http.get('/health/live').expect(200)).body).toEqual({ status: 'ok' });
    expect((await ctx.http.get('/health/ready').expect(200)).body).toEqual({ status: 'ok', database: 'ok' });
  });

  it('reports 503 when the database is unreachable', async () => {
    const broken = await createTestContext();
    await broken.pool.end();
    try {
      const res = await broken.http.get('/health/ready').expect(503);
      expect(res.body.status).toBe('unavailable');
    } finally {
      await new Promise<void>((resolve) => broken.server.close(() => resolve()));
    }
  });
});
