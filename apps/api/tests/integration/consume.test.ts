import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consume,
  createAccount,
  createCustomPlan,
  createTestContext,
  createUser,
  decisionResponseSchema,
  predefinedPlanId,
  readCounters,
  setupScenario,
  TestClock,
  uniqueId,
  type TestContext,
} from '../helpers.js';

const clock = new TestClock(new Date('2026-03-10T09:00:00.000Z'));
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ clock });
});
afterAll(() => ctx.close());

/** Limits from the specification's worked example. */
const SPEC_LIMITS = {
  account: { monthlyLimit: 10_000, perRequestLimit: 100 },
  user: { monthlyLimit: 1_000, perRequestLimit: 20 },
};

describe('accepted requests', () => {
  it('consume the same units at the account and user level and report remaining allowance', async () => {
    const { account, userIds, accountPlanId, userPlanId } = await setupScenario(ctx, SPEC_LIMITS);
    const res = await consume(ctx, account, userIds[0]!, 10, 'accept-1').expect(200);
    const body = decisionResponseSchema.parse(res.body);
    expect(res.headers['idempotent-replayed']).toBe('false');
    expect(body).toMatchObject({
      decision: 'accepted',
      requestId: 'accept-1',
      units: 10,
      unitsAccepted: 10,
      month: '2026-03',
      replayed: false,
      rejection: null,
      account: { planId: accountPlanId, monthlyLimit: 10_000, perRequestLimit: 100, usedUnits: 10, remaining: 9_990 },
      user: { planId: userPlanId, monthlyLimit: 1_000, perRequestLimit: 20, usedUnits: 10, remaining: 990 },
    });
    expect(await readCounters(ctx, account.id, '2026-03')).toEqual({ accountUsed: 10, usersSum: 10, acceptedSum: 10 });
  });

  it('work with the default predefined plans (Starter + Basic)', async () => {
    const account = await createAccount(ctx);
    const userId = await createUser(ctx, account);
    const res = await consume(ctx, account, userId, 20).expect(200);
    expect(res.body).toMatchObject({ decision: 'accepted', account: { remaining: 9_980 }, user: { remaining: 980 } });
  });
});

describe('rejections', () => {
  it('USER_PER_REQUEST_LIMIT_EXCEEDED: 25 units against a 20-unit user limit', async () => {
    const { account, userIds } = await setupScenario(ctx, SPEC_LIMITS);
    const res = await consume(ctx, account, userIds[0]!, 25).expect(200);
    const body = decisionResponseSchema.parse(res.body);
    expect(body.decision).toBe('rejected');
    expect(body.unitsAccepted).toBe(0);
    expect(body.rejection).toEqual({
      code: 'USER_PER_REQUEST_LIMIT_EXCEEDED',
      level: 'user',
      limitType: 'per_request',
      limit: 20,
      available: null,
      message: expect.any(String),
    });
    expect(body.account.usedUnits).toBe(0);
    expect(body.user.usedUnits).toBe(0);
  });

  it('ACCOUNT_PER_REQUEST_LIMIT_EXCEEDED: user allows more than the account does', async () => {
    const { account, userIds } = await setupScenario(ctx, {
      account: { monthlyLimit: 10_000, perRequestLimit: 50 },
      user: { monthlyLimit: 1_000, perRequestLimit: 500 },
    });
    const res = await consume(ctx, account, userIds[0]!, 60).expect(200);
    expect(res.body.rejection).toMatchObject({ code: 'ACCOUNT_PER_REQUEST_LIMIT_EXCEEDED', level: 'account', limit: 50 });
  });

  it('ACCOUNT_MONTHLY_LIMIT_EXCEEDED: only 5 shared units left although the user has plenty', async () => {
    const { account, userIds } = await setupScenario(
      ctx,
      { account: { monthlyLimit: 105, perRequestLimit: 100 }, user: { monthlyLimit: 1_000, perRequestLimit: 100 } },
      2,
    );
    await consume(ctx, account, userIds[0]!, 100).expect(200);
    const res = await consume(ctx, account, userIds[1]!, 10).expect(200);
    expect(res.body).toMatchObject({
      decision: 'rejected',
      rejection: { code: 'ACCOUNT_MONTHLY_LIMIT_EXCEEDED', level: 'account', limitType: 'monthly', limit: 105, available: 5 },
      account: { usedUnits: 100, remaining: 5 },
      user: { usedUnits: 0, remaining: 1_000 },
    });
  });

  it('USER_MONTHLY_LIMIT_EXCEEDED', async () => {
    const { account, userIds } = await setupScenario(ctx, {
      account: { monthlyLimit: 10_000, perRequestLimit: 100 },
      user: { monthlyLimit: 30, perRequestLimit: 20 },
    });
    await consume(ctx, account, userIds[0]!, 20).expect(200);
    const res = await consume(ctx, account, userIds[0]!, 15).expect(200);
    expect(res.body.rejection).toMatchObject({ code: 'USER_MONTHLY_LIMIT_EXCEEDED', level: 'user', limit: 30, available: 10 });
  });

  it('consume nothing at either level and are still recorded', async () => {
    const { account, userIds } = await setupScenario(ctx, SPEC_LIMITS);
    await consume(ctx, account, userIds[0]!, 10).expect(200);
    for (const units of [25, 21, 500]) {
      expect((await consume(ctx, account, userIds[0]!, units).expect(200)).body.decision).toBe('rejected');
    }
    expect(await readCounters(ctx, account.id, '2026-03')).toEqual({ accountUsed: 10, usersSum: 10, acceptedSum: 10 });
    const history = await ctx.http.get('/v1/usage/requests').set('X-API-Key', account.apiKey).expect(200);
    expect(history.body.data).toHaveLength(4);
  });

  it('follow the documented precedence when several limits fail at once', async () => {
    const { account, userIds } = await setupScenario(ctx, {
      account: { monthlyLimit: 30, perRequestLimit: 30 },
      user: { monthlyLimit: 30, perRequestLimit: 10 },
    });
    await consume(ctx, account, userIds[0]!, 10).expect(200);
    await consume(ctx, account, userIds[0]!, 10).expect(200);
    await consume(ctx, account, userIds[0]!, 10).expect(200);
    // Now both monthly allowances are exhausted too.
    const codes = [];
    for (const units of [40, 15, 5]) {
      codes.push((await consume(ctx, account, userIds[0]!, units).expect(200)).body.rejection.code);
    }
    expect(codes).toEqual(['ACCOUNT_PER_REQUEST_LIMIT_EXCEEDED', 'USER_PER_REQUEST_LIMIT_EXCEEDED', 'ACCOUNT_MONTHLY_LIMIT_EXCEEDED']);
  });
});

describe('boundaries', () => {
  it('accepts a request that exactly exhausts the allowance, then rejects the next unit', async () => {
    const { account, userIds } = await setupScenario(ctx, {
      account: { monthlyLimit: 1_000, perRequestLimit: 100 },
      user: { monthlyLimit: 25, perRequestLimit: 25 },
    });
    const exact = await consume(ctx, account, userIds[0]!, 25).expect(200);
    expect(exact.body).toMatchObject({ decision: 'accepted', user: { usedUnits: 25, remaining: 0 } });
    const over = await consume(ctx, account, userIds[0]!, 1).expect(200);
    expect(over.body).toMatchObject({ decision: 'rejected', rejection: { code: 'USER_MONTHLY_LIMIT_EXCEEDED', available: 0 } });
  });

  it('accepts exactly the per-request limit', async () => {
    const { account, userIds } = await setupScenario(ctx, SPEC_LIMITS);
    expect((await consume(ctx, account, userIds[0]!, 20).expect(200)).body.decision).toBe('accepted');
    expect((await consume(ctx, account, userIds[0]!, 21).expect(200)).body.decision).toBe('rejected');
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 1.5],
    ['numeric string', '5'],
    ['NaN-like string', 'abc'],
    ['missing', undefined],
  ])('rejects %s units with 400 and records nothing', async (_label, units) => {
    const { account, userIds } = await setupScenario(ctx, SPEC_LIMITS);
    const requestId = uniqueId('invalid');
    const res = await ctx.http
      .post('/v1/usage/consume')
      .set('X-API-Key', account.apiKey)
      .send({ userId: userIds[0], units, requestId })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain('units');
    const rows = await ctx.pool.query('SELECT 1 FROM usage_requests WHERE request_id = $1', [requestId]);
    expect(rows.rowCount).toBe(0);
  });

  it('validates requestId', async () => {
    const { account, userIds } = await setupScenario(ctx, SPEC_LIMITS);
    for (const requestId of ['', 'has space', 'x'.repeat(129), 'emoji-🙂', undefined]) {
      await ctx.http
        .post('/v1/usage/consume')
        .set('X-API-Key', account.apiKey)
        .send({ userId: userIds[0], units: 1, requestId })
        .expect(400);
    }
  });

  it('rejects unknown users with 404 and records nothing', async () => {
    const account = await createAccount(ctx);
    const res = await consume(ctx, account, crypto.randomUUID(), 1).expect(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
    const counters = await ctx.pool.query('SELECT 1 FROM account_monthly_usage WHERE account_id = $1', [account.id]);
    expect(counters.rowCount).toBe(0);
  });
});

describe('shared plans and shared account allowance', () => {
  it('users on the same plan keep independent usage; the account total is their sum', async () => {
    const { account, userIds, userPlanId } = await setupScenario(ctx, SPEC_LIMITS, 2);
    const [alice, bob] = userIds as [string, string];
    await consume(ctx, account, alice, 20).expect(200);
    await consume(ctx, account, alice, 15).expect(200);
    await consume(ctx, account, bob, 5).expect(200);
    const a = await ctx.http.get(`/v1/users/${alice}`).set('X-API-Key', account.apiKey).expect(200);
    const b = await ctx.http.get(`/v1/users/${bob}`).set('X-API-Key', account.apiKey).expect(200);
    expect(a.body.plan.id).toBe(userPlanId);
    expect(b.body.plan.id).toBe(userPlanId);
    expect(a.body.usage.usedUnits).toBe(35);
    expect(b.body.usage.usedUnits).toBe(5);
    const acct = await ctx.http.get('/v1/account').set('X-API-Key', account.apiKey).expect(200);
    expect(acct.body.usage.usedUnits).toBe(40);
    expect(await readCounters(ctx, account.id, '2026-03')).toEqual({ accountUsed: 40, usersSum: 40, acceptedSum: 40 });
  });
});

describe('UTC monthly accounting', () => {
  it('assigns requests to the UTC month of processing and starts each month at zero', async () => {
    const monthClock = new TestClock(new Date('2026-01-31T23:59:59.999Z'));
    const local = await createTestContext({ clock: monthClock });
    try {
      const { account, userIds } = await setupScenario(local, {
        account: { monthlyLimit: 100, perRequestLimit: 100 },
        user: { monthlyLimit: 60, perRequestLimit: 60 },
      });
      const user = userIds[0]!;
      const jan = await consume(local, account, user, 60).expect(200);
      expect(jan.body).toMatchObject({ decision: 'accepted', month: '2026-01' });
      expect((await consume(local, account, user, 1).expect(200)).body.decision).toBe('rejected');

      monthClock.set('2026-02-01T00:00:00.000Z');
      const feb = await consume(local, account, user, 60).expect(200);
      expect(feb.body).toMatchObject({ decision: 'accepted', month: '2026-02', user: { usedUnits: 60 }, account: { usedUnits: 60 } });

      // January's history and totals are preserved, not reset.
      const janUsage = await local.http.get('/v1/account/usage?month=2026-01').set('X-API-Key', account.apiKey).expect(200);
      expect(janUsage.body).toEqual({ month: '2026-01', usedUnits: 60, isCurrentMonth: false, monthlyLimit: null, remaining: null });
      const febUsage = await local.http.get('/v1/account/usage').set('X-API-Key', account.apiKey).expect(200);
      expect(febUsage.body).toEqual({ month: '2026-02', usedUnits: 60, isCurrentMonth: true, monthlyLimit: 100, remaining: 40 });
      const userJan = await local.http.get(`/v1/users/${user}/usage?month=2026-01`).set('X-API-Key', account.apiKey).expect(200);
      expect(userJan.body.usedUnits).toBe(60);
      const janHistory = await local.http
        .get('/v1/usage/requests?month=2026-01')
        .set('X-API-Key', account.apiKey)
        .expect(200);
      expect(janHistory.body.data).toHaveLength(2);
      expect(await readCounters(local, account.id, '2026-01')).toEqual({ accountUsed: 60, usersSum: 60, acceptedSum: 60 });
    } finally {
      await local.close();
    }
  });

  it('returns gap-free monthly series with zeros, and zero usage for months without records', async () => {
    const seriesClock = new TestClock(new Date('2025-11-20T10:00:00.000Z'));
    const local = await createTestContext({ clock: seriesClock });
    try {
      const { account, userIds } = await setupScenario(local, SPEC_LIMITS);
      await consume(local, account, userIds[0]!, 7).expect(200);
      seriesClock.set('2026-01-05T10:00:00.000Z');
      await consume(local, account, userIds[0]!, 3).expect(200);

      const series = await local.http
        .get('/v1/account/usage/monthly?from=2025-10&to=2026-02')
        .set('X-API-Key', account.apiKey)
        .expect(200);
      expect(series.body).toEqual({
        from: '2025-10',
        to: '2026-02',
        data: [
          { month: '2025-10', usedUnits: 0 },
          { month: '2025-11', usedUnits: 7 },
          { month: '2025-12', usedUnits: 0 },
          { month: '2026-01', usedUnits: 3 },
          { month: '2026-02', usedUnits: 0 },
        ],
      });
      const userSeries = await local.http
        .get(`/v1/users/${userIds[0]}/usage/monthly?from=2025-11&to=2026-01`)
        .set('X-API-Key', account.apiKey)
        .expect(200);
      expect(userSeries.body.data.map((m: { usedUnits: number }) => m.usedUnits)).toEqual([7, 0, 3]);
      const defaultWindow = await local.http.get('/v1/account/usage/monthly').set('X-API-Key', account.apiKey).expect(200);
      expect(defaultWindow.body).toMatchObject({ from: '2025-02', to: '2026-01' });
      expect(defaultWindow.body.data).toHaveLength(12);

      const empty = await local.http.get('/v1/account/usage?month=2020-05').set('X-API-Key', account.apiKey).expect(200);
      expect(empty.body.usedUnits).toBe(0);
    } finally {
      await local.close();
    }
  });

  it('validates month parameters', async () => {
    const account = await createAccount(ctx);
    for (const query of ['month=2026-13', 'month=2026-1', 'month=March', 'month=2026-03-01']) {
      await ctx.http.get(`/v1/account/usage?${query}`).set('X-API-Key', account.apiKey).expect(400);
    }
    for (const query of ['from=2026-05&to=2026-01', 'from=2020-01&to=2026-01', 'to=2026-00']) {
      await ctx.http.get(`/v1/account/usage/monthly?${query}`).set('X-API-Key', account.apiKey).expect(400);
    }
    await ctx.http.get('/v1/usage/requests?month=bad').set('X-API-Key', account.apiKey).expect(400);
  });
});

describe('plan changes', () => {
  it('updating a custom plan affects every entity on it for subsequent requests', async () => {
    const { account, userIds, userPlanId } = await setupScenario(ctx, SPEC_LIMITS, 2);
    const [alice, bob] = userIds as [string, string];
    expect((await consume(ctx, account, alice, 30).expect(200)).body.decision).toBe('rejected');
    await ctx.http.patch(`/v1/plans/${userPlanId}`).set('X-API-Key', account.apiKey).send({ perRequestLimit: 40 }).expect(200);
    const a = await consume(ctx, account, alice, 30).expect(200);
    const b = await consume(ctx, account, bob, 30).expect(200);
    expect(a.body).toMatchObject({ decision: 'accepted', user: { perRequestLimit: 40, planVersion: 2 } });
    expect(b.body).toMatchObject({ decision: 'accepted', user: { perRequestLimit: 40, planVersion: 2 } });
  });

  it('updating an account plan changes the shared limit for subsequent requests', async () => {
    const { account, userIds, accountPlanId } = await setupScenario(ctx, {
      account: { monthlyLimit: 50, perRequestLimit: 50 },
      user: { monthlyLimit: 1_000, perRequestLimit: 50 },
    });
    await consume(ctx, account, userIds[0]!, 50).expect(200);
    expect((await consume(ctx, account, userIds[0]!, 10).expect(200)).body.rejection.code).toBe('ACCOUNT_MONTHLY_LIMIT_EXCEEDED');
    await ctx.http.patch(`/v1/plans/${accountPlanId}`).set('X-API-Key', account.apiKey).send({ monthlyLimit: 100 }).expect(200);
    expect((await consume(ctx, account, userIds[0]!, 10).expect(200)).body).toMatchObject({
      decision: 'accepted',
      account: { usedUnits: 60, remaining: 40, monthlyLimit: 100 },
    });
  });

  it('switching to another plan preserves usage and applies the new limits', async () => {
    const { account, userIds } = await setupScenario(ctx, SPEC_LIMITS);
    const user = userIds[0]!;
    await consume(ctx, account, user, 20).expect(200);
    const tiny = await createCustomPlan(ctx, account, { scope: 'user', monthlyLimit: 25, perRequestLimit: 20 });
    await ctx.http.put(`/v1/users/${user}/plan`).set('X-API-Key', account.apiKey).send({ planId: tiny }).expect(200);
    const res = await consume(ctx, account, user, 10).expect(200);
    expect(res.body).toMatchObject({
      decision: 'rejected',
      rejection: { code: 'USER_MONTHLY_LIMIT_EXCEEDED', available: 5 },
      user: { planId: tiny, usedUnits: 20, remaining: 5 },
    });
    const premium = await predefinedPlanId(ctx, 'premium');
    await ctx.http.put(`/v1/users/${user}/plan`).set('X-API-Key', account.apiKey).send({ planId: premium }).expect(200);
    expect((await consume(ctx, account, user, 10).expect(200)).body).toMatchObject({ decision: 'accepted', user: { usedUnits: 30 } });
  });

  it('lowering a limit below current usage keeps history, clamps remaining at zero and blocks further use', async () => {
    const { account, userIds, userPlanId } = await setupScenario(ctx, SPEC_LIMITS);
    const user = userIds[0]!;
    await consume(ctx, account, user, 20).expect(200);
    await consume(ctx, account, user, 20).expect(200);
    await ctx.http.patch(`/v1/plans/${userPlanId}`).set('X-API-Key', account.apiKey).send({ monthlyLimit: 10 }).expect(200);

    const detail = await ctx.http.get(`/v1/users/${user}`).set('X-API-Key', account.apiKey).expect(200);
    expect(detail.body.usage).toMatchObject({ usedUnits: 40, monthlyLimit: 10, remaining: 0 });
    expect(detail.body.effective.availableThisMonth).toBe(0);
    const rejected = await consume(ctx, account, user, 1).expect(200);
    expect(rejected.body).toMatchObject({
      decision: 'rejected',
      rejection: { code: 'USER_MONTHLY_LIMIT_EXCEEDED', available: 0 },
      user: { usedUnits: 40, remaining: 0 },
    });
    const history = await ctx.http.get(`/v1/usage/requests?userId=${user}&status=accepted`).set('X-API-Key', account.apiKey).expect(200);
    expect(history.body.data).toHaveLength(2);
  });

  it('historical decisions keep the limits they were evaluated against', async () => {
    const { account, userIds, userPlanId } = await setupScenario(ctx, SPEC_LIMITS);
    const user = userIds[0]!;
    await consume(ctx, account, user, 25, 'explain-before').expect(200);
    await ctx.http
      .patch(`/v1/plans/${userPlanId}`)
      .set('X-API-Key', account.apiKey)
      .send({ perRequestLimit: 50, monthlyLimit: 2_000 })
      .expect(200);
    await consume(ctx, account, user, 25, 'explain-after').expect(200);

    const history = await ctx.http.get('/v1/usage/requests').set('X-API-Key', account.apiKey).expect(200);
    const byId = Object.fromEntries((history.body.data as Array<{ requestId: string }>).map((r) => [r.requestId, r]));
    expect(byId['explain-before']).toMatchObject({
      decision: 'rejected',
      rejection: { code: 'USER_PER_REQUEST_LIMIT_EXCEEDED', limit: 20 },
      user: { planVersion: 1, perRequestLimit: 20, monthlyLimit: 1_000 },
    });
    expect(byId['explain-after']).toMatchObject({
      decision: 'accepted',
      user: { planVersion: 2, perRequestLimit: 50, monthlyLimit: 2_000 },
    });
  });
});
