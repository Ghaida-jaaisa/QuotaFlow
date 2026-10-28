import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccount,
  createCustomPlan,
  createTestContext,
  predefinedPlanId,
  type TestAccount,
  type TestContext,
} from '../helpers.js';

let ctx: TestContext;
let account: TestAccount;

beforeAll(async () => {
  ctx = await createTestContext();
  account = await createAccount(ctx);
});
afterAll(() => ctx.close());

describe('predefined plans', () => {
  it('exist after initialization with their configured limits, publicly readable', async () => {
    const res = await ctx.http.get('/v1/plans/predefined').expect(200);
    const summary = (res.body.data as Array<Record<string, unknown>>).map(({ code, scope, monthlyLimit, perRequestLimit, kind }) => ({
      code,
      scope,
      monthlyLimit,
      perRequestLimit,
      kind,
    }));
    expect(summary).toEqual(
      expect.arrayContaining([
        { code: 'starter', scope: 'account', monthlyLimit: 10_000, perRequestLimit: 100, kind: 'predefined' },
        { code: 'pro', scope: 'account', monthlyLimit: 100_000, perRequestLimit: 1_000, kind: 'predefined' },
        { code: 'basic', scope: 'user', monthlyLimit: 1_000, perRequestLimit: 20, kind: 'predefined' },
        { code: 'premium', scope: 'user', monthlyLimit: 5_000, perRequestLimit: 100, kind: 'predefined' },
      ]),
    );
    expect(summary).toHaveLength(4);
  });

  it('can be filtered by scope', async () => {
    const res = await ctx.http.get('/v1/plans/predefined?scope=user').expect(200);
    expect((res.body.data as Array<{ scope: string }>).every((p) => p.scope === 'user')).toBe(true);
    await ctx.http.get('/v1/plans/predefined?scope=team').expect(400);
  });

  it('cannot be modified through the API', async () => {
    const starter = await predefinedPlanId(ctx, 'starter');
    const res = await ctx.http
      .patch(`/v1/plans/${starter}`)
      .set('X-API-Key', account.apiKey)
      .send({ monthlyLimit: 999_999 })
      .expect(403);
    expect(res.body.error.code).toBe('PREDEFINED_PLAN_READ_ONLY');
    const after = await ctx.http.get(`/v1/plans/${starter}`).set('X-API-Key', account.apiKey).expect(200);
    expect(after.body.monthlyLimit).toBe(10_000);
    expect(after.body.version).toBe(1);
  });

  it('are listed alongside the account’s custom plans', async () => {
    const planId = await createCustomPlan(ctx, account, { scope: 'user', monthlyLimit: 50, perRequestLimit: 5 });
    const all = await ctx.http.get('/v1/plans').set('X-API-Key', account.apiKey).expect(200);
    const kinds = new Set((all.body.data as Array<{ kind: string }>).map((p) => p.kind));
    expect(kinds).toEqual(new Set(['predefined', 'custom']));
    const custom = await ctx.http.get('/v1/plans?kind=custom&scope=user').set('X-API-Key', account.apiKey).expect(200);
    expect((custom.body.data as Array<{ id: string }>).map((p) => p.id)).toContain(planId);
    expect((custom.body.data as Array<{ kind: string; scope: string }>).every((p) => p.kind === 'custom' && p.scope === 'user')).toBe(true);
  });
});

describe('custom plans', () => {
  it('can be created for both scopes and read back', async () => {
    for (const scope of ['account', 'user'] as const) {
      const created = await ctx.http
        .post('/v1/plans')
        .set('X-API-Key', account.apiKey)
        .send({ name: `Custom ${scope}`, scope, monthlyLimit: 500, perRequestLimit: 50 })
        .expect(201);
      expect(created.body).toMatchObject({ scope, kind: 'custom', code: null, monthlyLimit: 500, perRequestLimit: 50, version: 1 });
      const read = await ctx.http.get(`/v1/plans/${created.body.id}`).set('X-API-Key', account.apiKey).expect(200);
      expect(read.body).toEqual(created.body);
    }
  });

  it('can be updated, incrementing the version', async () => {
    const planId = await createCustomPlan(ctx, account, { scope: 'user', monthlyLimit: 100, perRequestLimit: 10 });
    const updated = await ctx.http
      .patch(`/v1/plans/${planId}`)
      .set('X-API-Key', account.apiKey)
      .send({ monthlyLimit: 250 })
      .expect(200);
    expect(updated.body).toMatchObject({ monthlyLimit: 250, perRequestLimit: 10, version: 2 });
    const renamed = await ctx.http
      .patch(`/v1/plans/${planId}`)
      .set('X-API-Key', account.apiKey)
      .send({ name: 'Renamed', perRequestLimit: 25 })
      .expect(200);
    expect(renamed.body).toMatchObject({ name: 'Renamed', monthlyLimit: 250, perRequestLimit: 25, version: 3 });
  });

  it('rejects an empty update, unknown fields and scope changes', async () => {
    const planId = await createCustomPlan(ctx, account, { scope: 'user', monthlyLimit: 100, perRequestLimit: 10 });
    for (const body of [{}, { color: 'blue' }, { scope: 'account' }]) {
      const res = await ctx.http.patch(`/v1/plans/${planId}`).set('X-API-Key', account.apiKey).send(body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 2.5],
    ['string', '100'],
    ['too large', 2_000_000_000],
    ['null', null],
  ])('rejects a %s limit', async (_label, value) => {
    const res = await ctx.http
      .post('/v1/plans')
      .set('X-API-Key', account.apiKey)
      .send({ name: 'Bad', scope: 'user', monthlyLimit: value, perRequestLimit: 10 })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].path).toBe('monthlyLimit');
  });

  it('rejects a missing or unknown scope', async () => {
    await ctx.http
      .post('/v1/plans')
      .set('X-API-Key', account.apiKey)
      .send({ name: 'No scope', monthlyLimit: 10, perRequestLimit: 1 })
      .expect(400);
    await ctx.http
      .post('/v1/plans')
      .set('X-API-Key', account.apiKey)
      .send({ name: 'Team', scope: 'team', monthlyLimit: 10, perRequestLimit: 1 })
      .expect(400);
  });

  it('rejects duplicate names within an account and scope with 409', async () => {
    const body = { name: 'Duplicate', scope: 'user', monthlyLimit: 10, perRequestLimit: 1 };
    await ctx.http.post('/v1/plans').set('X-API-Key', account.apiKey).send(body).expect(201);
    const dup = await ctx.http.post('/v1/plans').set('X-API-Key', account.apiKey).send(body).expect(409);
    expect(dup.body.error.code).toBe('PLAN_NAME_TAKEN');
    // The same name is fine in the other scope and in another account.
    await ctx.http.post('/v1/plans').set('X-API-Key', account.apiKey).send({ ...body, scope: 'account' }).expect(201);
    const other = await createAccount(ctx);
    await ctx.http.post('/v1/plans').set('X-API-Key', other.apiKey).send(body).expect(201);
  });

  it('returns 404 for unknown plans and 400 for malformed plan IDs', async () => {
    const missing = await ctx.http.get(`/v1/plans/${crypto.randomUUID()}`).set('X-API-Key', account.apiKey).expect(404);
    expect(missing.body.error.code).toBe('PLAN_NOT_FOUND');
    await ctx.http.get('/v1/plans/123').set('X-API-Key', account.apiKey).expect(400);
  });
});

describe('plan assignment', () => {
  it('rejects assigning a user plan to an account and an account plan to a user (422)', async () => {
    const userPlan = await createCustomPlan(ctx, account, { scope: 'user', monthlyLimit: 10, perRequestLimit: 1 });
    const accountPlan = await createCustomPlan(ctx, account, { scope: 'account', monthlyLimit: 10, perRequestLimit: 1 });
    const toAccount = await ctx.http.put('/v1/account/plan').set('X-API-Key', account.apiKey).send({ planId: userPlan }).expect(422);
    expect(toAccount.body.error.code).toBe('PLAN_SCOPE_MISMATCH');
    const toNewUser = await ctx.http
      .post('/v1/users')
      .set('X-API-Key', account.apiKey)
      .send({ name: 'u', planId: accountPlan })
      .expect(422);
    expect(toNewUser.body.error.code).toBe('PLAN_SCOPE_MISMATCH');
    const premiumAsAccount = await ctx.http
      .put('/v1/account/plan')
      .set('X-API-Key', account.apiKey)
      .send({ planId: await predefinedPlanId(ctx, 'premium') })
      .expect(422);
    expect(premiumAsAccount.body.error.code).toBe('PLAN_SCOPE_MISMATCH');
  });

  it('is also enforced by the database: a user cannot reference an account-scope plan', async () => {
    const proPlan = await predefinedPlanId(ctx, 'pro');
    const user = await ctx.http.post('/v1/users').set('X-API-Key', account.apiKey).send({ name: 'db-check' }).expect(201);
    // Bypass the API entirely: the composite (plan_id, plan_scope) foreign key must refuse this.
    await expect(ctx.pool.query('UPDATE users SET plan_id = $1 WHERE id = $2', [proPlan, user.body.id])).rejects.toThrow(
      /users_plan_fk/,
    );
  });

  it('switches the account between predefined and custom plans', async () => {
    const pro = await predefinedPlanId(ctx, 'pro');
    const res = await ctx.http.put('/v1/account/plan').set('X-API-Key', account.apiKey).send({ planId: pro }).expect(200);
    expect(res.body.plan.code).toBe('pro');
    expect(res.body.usage.monthlyLimit).toBe(100_000);
    const custom = await createCustomPlan(ctx, account, { scope: 'account', monthlyLimit: 777, perRequestLimit: 7 });
    const switched = await ctx.http.put('/v1/account/plan').set('X-API-Key', account.apiKey).send({ planId: custom }).expect(200);
    expect(switched.body.plan).toMatchObject({ id: custom, kind: 'custom', monthlyLimit: 777 });
  });
});
