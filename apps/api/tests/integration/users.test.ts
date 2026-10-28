import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consume,
  createAccount,
  createCustomPlan,
  createTestContext,
  createUser,
  predefinedPlanId,
  TestClock,
  type TestAccount,
  type TestContext,
} from '../helpers.js';

const clock = new TestClock(new Date('2026-06-15T12:00:00.000Z'));
let ctx: TestContext;
let account: TestAccount;

beforeAll(async () => {
  ctx = await createTestContext({ clock });
  account = await createAccount(ctx);
});
afterAll(() => ctx.close());

describe('users', () => {
  it('are created on the Basic plan by default with zero usage', async () => {
    const res = await ctx.http.post('/v1/users').set('X-API-Key', account.apiKey).send({ name: 'alice' }).expect(201);
    expect(res.body).toMatchObject({
      accountId: account.id,
      name: 'alice',
      plan: { code: 'basic', scope: 'user' },
      usage: { month: '2026-06', usedUnits: 0, monthlyLimit: 1_000, perRequestLimit: 20, remaining: 1_000 },
    });
  });

  it('can be created on a chosen predefined or custom user plan', async () => {
    const premium = await predefinedPlanId(ctx, 'premium');
    const withPremium = await ctx.http
      .post('/v1/users')
      .set('X-API-Key', account.apiKey)
      .send({ name: 'bob', planId: premium })
      .expect(201);
    expect(withPremium.body.plan.code).toBe('premium');
    const custom = await createCustomPlan(ctx, account, { scope: 'user', monthlyLimit: 42, perRequestLimit: 4 });
    const withCustom = await ctx.http
      .post('/v1/users')
      .set('X-API-Key', account.apiKey)
      .send({ name: 'carol', planId: custom })
      .expect(201);
    expect(withCustom.body.plan).toMatchObject({ id: custom, kind: 'custom', monthlyLimit: 42 });
  });

  it('rejects invalid user payloads', async () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(101) }, { name: 'ok', planId: 'nope' }]) {
      const res = await ctx.http.post('/v1/users').set('X-API-Key', account.apiKey).send(body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('report details with both levels and the effective limits', async () => {
    const userId = await createUser(ctx, account);
    await consume(ctx, account, userId, 15).expect(200);
    const res = await ctx.http.get(`/v1/users/${userId}`).set('X-API-Key', account.apiKey).expect(200);
    expect(res.body.usage).toEqual({ month: '2026-06', usedUnits: 15, monthlyLimit: 1_000, perRequestLimit: 20, remaining: 985 });
    expect(res.body.accountUsage).toMatchObject({ monthlyLimit: 10_000, perRequestLimit: 100 });
    expect(res.body.effective).toEqual({
      maxUnitsPerRequest: 20,
      availableThisMonth: Math.min(985, res.body.accountUsage.remaining),
    });
  });

  it('can switch plans, preserving their monthly usage', async () => {
    const userId = await createUser(ctx, account);
    await consume(ctx, account, userId, 20).expect(200);
    const premium = await predefinedPlanId(ctx, 'premium');
    const res = await ctx.http.put(`/v1/users/${userId}/plan`).set('X-API-Key', account.apiKey).send({ planId: premium }).expect(200);
    expect(res.body.plan.code).toBe('premium');
    expect(res.body.usage).toMatchObject({ usedUnits: 20, monthlyLimit: 5_000, remaining: 4_980 });
  });

  it('return 404 for unknown users and 400 for malformed IDs', async () => {
    const unknown = await ctx.http.get(`/v1/users/${crypto.randomUUID()}`).set('X-API-Key', account.apiKey).expect(404);
    expect(unknown.body.error.code).toBe('USER_NOT_FOUND');
    await ctx.http.get('/v1/users/12345').set('X-API-Key', account.apiKey).expect(400);
  });

  it('are listed with stable cursor pagination, including identical creation timestamps', async () => {
    // The fixed clock gives every user the same created_at, so ordering relies on the id tie-breaker.
    const fresh = await createAccount(ctx);
    const created = new Set<string>();
    for (let i = 0; i < 7; i++) {
      created.add(await createUser(ctx, fresh, undefined, `listed-${i}`));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: Response = await ctx.http
        .get('/v1/users')
        .query({ limit: 3, ...(cursor ? { cursor } : {}) })
        .set('X-API-Key', fresh.apiKey)
        .expect(200);
      seen.push(...(res.body.data as Array<{ id: string }>).map((u) => u.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(created);
  });

  it('validate pagination parameters', async () => {
    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'cursor=garbage']) {
      const res = await ctx.http.get(`/v1/users?${query}`).set('X-API-Key', account.apiKey).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('account overview', () => {
  it('shows the current plan, effective limits and usage', async () => {
    const fresh = await createAccount(ctx, 'Overview');
    const userId = await createUser(ctx, fresh);
    await consume(ctx, fresh, userId, 12).expect(200);
    const res = await ctx.http.get('/v1/account').set('X-API-Key', fresh.apiKey).expect(200);
    expect(res.body).toMatchObject({
      id: fresh.id,
      name: 'Overview',
      plan: { code: 'starter', monthlyLimit: 10_000, perRequestLimit: 100 },
      usage: { month: '2026-06', usedUnits: 12, monthlyLimit: 10_000, perRequestLimit: 100, remaining: 9_988 },
    });
  });
});
