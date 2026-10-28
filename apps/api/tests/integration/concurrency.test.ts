import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monthOf } from '../../src/domain/month.js';
import {
  consume,
  createAccount,
  createTestContext,
  createUser,
  decisionResponseSchema,
  readCounters,
  runWithConcurrency,
  setupScenario,
  TestClock,
  uniqueId,
  type DecisionResponse,
  type TestContext,
} from '../helpers.js';

// A pool larger than the burst size so requests genuinely run in parallel
// transactions and contend on row locks instead of queueing for connections.
let ctx: TestContext;
const currentMonth = () => monthOf(new Date());

beforeAll(async () => {
  ctx = await createTestContext({ poolMax: 25 });
});
afterAll(() => ctx.close());

const parse = (body: unknown): DecisionResponse => decisionResponseSchema.parse(body);

describe('idempotency', () => {
  it('returns the original decision for a retried request without consuming again', async () => {
    const { account, userIds } = await setupScenario(ctx, {
      account: { monthlyLimit: 1_000, perRequestLimit: 100 },
      user: { monthlyLimit: 1_000, perRequestLimit: 100 },
    });
    const first = parse((await consume(ctx, account, userIds[0]!, 40, 'retry-me').expect(200)).body);
    const second = await consume(ctx, account, userIds[0]!, 40, 'retry-me').expect(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    const replay = parse(second.body);
    expect(replay.replayed).toBe(true);
    expect({ ...replay, replayed: false }).toEqual(first);
    expect(await readCounters(ctx, account.id, currentMonth())).toEqual({ accountUsed: 40, usersSum: 40, acceptedSum: 40 });
  });

  it('rejects reuse of a requestId with different units or a different user (409)', async () => {
    const { account, userIds } = await setupScenario(
      ctx,
      { account: { monthlyLimit: 1_000, perRequestLimit: 100 }, user: { monthlyLimit: 1_000, perRequestLimit: 100 } },
      2,
    );
    await consume(ctx, account, userIds[0]!, 10, 'payload-bound').expect(200);
    const differentUnits = await consume(ctx, account, userIds[0]!, 11, 'payload-bound').expect(409);
    expect(differentUnits.body.error).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      details: { requestId: 'payload-bound', original: { userId: userIds[0], units: 10 } },
    });
    const differentUser = await consume(ctx, account, userIds[1]!, 10, 'payload-bound').expect(409);
    expect(differentUser.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await readCounters(ctx, account.id, currentMonth())).toEqual({ accountUsed: 10, usersSum: 10, acceptedSum: 10 });
  });

  it('replays a rejected decision even after the limits that caused it were raised', async () => {
    const { account, userIds, userPlanId } = await setupScenario(ctx, {
      account: { monthlyLimit: 1_000, perRequestLimit: 100 },
      user: { monthlyLimit: 1_000, perRequestLimit: 20 },
    });
    const original = parse((await consume(ctx, account, userIds[0]!, 50, 'rejected-once').expect(200)).body);
    expect(original.decision).toBe('rejected');
    await ctx.http.patch(`/v1/plans/${userPlanId}`).set('X-API-Key', account.apiKey).send({ perRequestLimit: 100 }).expect(200);
    const replay = parse((await consume(ctx, account, userIds[0]!, 50, 'rejected-once').expect(200)).body);
    expect(replay).toMatchObject({ decision: 'rejected', replayed: true, rejection: { code: 'USER_PER_REQUEST_LIMIT_EXCEEDED', limit: 20 } });
    // A new requestId is evaluated against the new limits.
    expect(parse((await consume(ctx, account, userIds[0]!, 50).expect(200)).body).decision).toBe('accepted');
  });

  it('replays an accepted decision unchanged after later usage and plan changes', async () => {
    const { account, userIds, accountPlanId } = await setupScenario(ctx, {
      account: { monthlyLimit: 100, perRequestLimit: 100 },
      user: { monthlyLimit: 100, perRequestLimit: 100 },
    });
    const original = parse((await consume(ctx, account, userIds[0]!, 30, 'stable-accept').expect(200)).body);
    await consume(ctx, account, userIds[0]!, 60).expect(200);
    await ctx.http.patch(`/v1/plans/${accountPlanId}`).set('X-API-Key', account.apiKey).send({ monthlyLimit: 40 }).expect(200);
    const replay = parse((await consume(ctx, account, userIds[0]!, 30, 'stable-accept').expect(200)).body);
    expect({ ...replay, replayed: false }).toEqual(original);
    expect(replay.account).toMatchObject({ usedUnits: 30, monthlyLimit: 100, remaining: 70 });
  });

  it('scopes request IDs per account', async () => {
    const a = await createAccount(ctx);
    const b = await createAccount(ctx);
    const ua = await createUser(ctx, a);
    const ub = await createUser(ctx, b);
    const ra = parse((await consume(ctx, a, ua, 5, 'shared-request-id').expect(200)).body);
    const rb = parse((await consume(ctx, b, ub, 5, 'shared-request-id').expect(200)).body);
    expect(ra.replayed).toBe(false);
    expect(rb.replayed).toBe(false);
    expect(ra.id).not.toBe(rb.id);
  });

  it('does not burn a requestId on validation errors', async () => {
    const account = await createAccount(ctx);
    const user = await createUser(ctx, account);
    await consume(ctx, account, user, 0, 'fix-and-retry').expect(400);
    expect(parse((await consume(ctx, account, user, 5, 'fix-and-retry').expect(200)).body).replayed).toBe(false);
  });

  it('charges concurrent duplicates exactly once and returns the same decision to all', async () => {
    const { account, userIds } = await setupScenario(ctx, {
      account: { monthlyLimit: 10_000, perRequestLimit: 100 },
      user: { monthlyLimit: 10_000, perRequestLimit: 100 },
    });
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => consume(ctx, account, userIds[0]!, 25, 'burst-duplicate')),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const bodies = responses.map((r) => parse(r.body));
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    expect(bodies.filter((b) => !b.replayed)).toHaveLength(1);
    expect(await readCounters(ctx, account.id, currentMonth())).toEqual({ accountUsed: 25, usersSum: 25, acceptedSum: 25 });
  });

  it('stays correct when duplicates race across a UTC month boundary (unique-constraint backstop)', async () => {
    // Two app instances whose clocks sit on either side of midnight lock
    // *different* monthly counter rows, so only the unique constraint can
    // stop a double charge. Repeat to exercise varied interleavings.
    const before = await createTestContext({ clock: new TestClock(new Date('2026-07-31T23:59:59.999Z')), poolMax: 5 });
    const after = await createTestContext({ clock: new TestClock(new Date('2026-08-01T00:00:00.000Z')), poolMax: 5 });
    try {
      const account = await createAccount(before);
      const user = await createUser(before, account);
      for (let i = 0; i < 10; i++) {
        const requestId = uniqueId('month-race');
        const [r1, r2] = await Promise.all([
          consume(before, account, user, 3, requestId),
          consume(after, account, user, 3, requestId),
        ]);
        expect([r1.status, r2.status]).toEqual([200, 200]);
        expect(r1.body.id).toBe(r2.body.id);
        expect([r1.body.replayed, r2.body.replayed].sort()).toEqual([false, true]);
      }
      const jul = await readCounters(before, account.id, '2026-07');
      const aug = await readCounters(before, account.id, '2026-08');
      expect(jul.accountUsed + aug.accountUsed).toBe(30);
      expect(jul).toEqual({ accountUsed: jul.acceptedSum, usersSum: jul.acceptedSum, acceptedSum: jul.acceptedSum });
      expect(aug).toEqual({ accountUsed: aug.acceptedSum, usersSum: aug.acceptedSum, acceptedSum: aug.acceptedSum });
    } finally {
      await before.close();
      await after.close();
    }
  });
});

describe('concurrent consumption', () => {
  it('accepts at most one of two concurrent 7-unit requests for the last 10 account units', async () => {
    // Repeated so the result does not depend on one lucky interleaving.
    for (let round = 0; round < 10; round++) {
      const { account, userIds } = await setupScenario(
        ctx,
        { account: { monthlyLimit: 11, perRequestLimit: 10 }, user: { monthlyLimit: 100, perRequestLimit: 10 } },
        2,
      );
      // Consume 1 unit first so the counter row already exists and exactly 10 remain.
      // (Racing on row *creation* would serialize on the unique key and hide a missing lock.)
      await consume(ctx, account, userIds[0]!, 1).expect(200);
      const results = (
        await Promise.all([consume(ctx, account, userIds[0]!, 7), consume(ctx, account, userIds[1]!, 7)])
      ).map((r) => parse(r.body));
      expect(results.filter((r) => r.decision === 'accepted')).toHaveLength(1);
      const rejected = results.find((r) => r.decision === 'rejected')!;
      expect(rejected.rejection).toMatchObject({ code: 'ACCOUNT_MONTHLY_LIMIT_EXCEEDED', available: 3 });
      expect(await readCounters(ctx, account.id, currentMonth())).toEqual({ accountUsed: 8, usersSum: 8, acceptedSum: 8 });
    }
  });

  it('accepts at most one of two concurrent 7-unit requests for the last 10 user units', async () => {
    for (let round = 0; round < 10; round++) {
      const { account, userIds } = await setupScenario(ctx, {
        account: { monthlyLimit: 1_000, perRequestLimit: 10 },
        user: { monthlyLimit: 11, perRequestLimit: 10 },
      });
      await consume(ctx, account, userIds[0]!, 1).expect(200);
      const results = (
        await Promise.all([consume(ctx, account, userIds[0]!, 7), consume(ctx, account, userIds[0]!, 7)])
      ).map((r) => parse(r.body));
      expect(results.filter((r) => r.decision === 'accepted')).toHaveLength(1);
      expect(results.find((r) => r.decision === 'rejected')!.rejection!.code).toBe('USER_MONTHLY_LIMIT_EXCEEDED');
    }
  });

  it('never exceeds account or user limits under a mixed burst, and counters equal the ledger', async () => {
    const accountLimit = 500;
    const userLimit = 150;
    const { account, userIds } = await setupScenario(
      ctx,
      { account: { monthlyLimit: accountLimit, perRequestLimit: 40 }, user: { monthlyLimit: userLimit, perRequestLimit: 30 } },
      5,
    );
    // Deterministic workload: 200 requests of 1..35 units (some exceed per-request limits).
    const requests = Array.from({ length: 200 }, (_, i) => ({ user: userIds[i % userIds.length]!, units: ((i * 7) % 35) + 1 }));
    const responses = await runWithConcurrency(requests.map((r) => () => consume(ctx, account, r.user, r.units)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const bodies = responses.map((r) => parse(r.body));

    const counters = await readCounters(ctx, account.id, currentMonth());
    const acceptedUnits = bodies.filter((b) => b.decision === 'accepted').reduce((sum, b) => sum + b.units, 0);
    expect(counters.accountUsed).toBeLessThanOrEqual(accountLimit);
    expect(counters).toEqual({ accountUsed: acceptedUnits, usersSum: acceptedUnits, acceptedSum: acceptedUnits });

    for (const userId of userIds) {
      const used = bodies.filter((b) => b.userId === userId && b.decision === 'accepted').reduce((s, b) => s + b.units, 0);
      expect(used).toBeLessThanOrEqual(userLimit);
      const detail = await ctx.http.get(`/v1/users/${userId}`).set('X-API-Key', account.apiKey).expect(200);
      expect(detail.body.usage.usedUnits).toBe(used);
    }
    // The ledger is a consistent serial history: each accepted record starts where the previous one ended.
    const ledger = await ctx.pool.query<{ account_used_before: number; account_used_after: number }>(
      `SELECT account_used_before, account_used_after FROM usage_requests
       WHERE account_id = $1 AND status = 'accepted' ORDER BY account_used_before`,
      [account.id],
    );
    let expectedBefore = 0;
    for (const row of ledger.rows) {
      expect(row.account_used_before).toBe(expectedBefore);
      expectedBefore = row.account_used_after;
    }
    expect(expectedBefore).toBe(acceptedUnits);
  });

  it('applies plan updates made during a burst consistently (each decision matches its recorded snapshot)', async () => {
    const { account, userIds, accountPlanId } = await setupScenario(
      ctx,
      { account: { monthlyLimit: 100, perRequestLimit: 10 }, user: { monthlyLimit: 1_000, perRequestLimit: 10 } },
      4,
    );
    const consumptions = Array.from({ length: 60 }, (_, i) => consume(ctx, account, userIds[i % 4]!, 5));
    const updates = [150, 200, 300].map((monthlyLimit) =>
      ctx.http.patch(`/v1/plans/${accountPlanId}`).set('X-API-Key', account.apiKey).send({ monthlyLimit }),
    );
    const [consumed, updated] = await Promise.all([Promise.all(consumptions), Promise.all(updates)]);
    expect(updated.every((r) => r.status === 200)).toBe(true);

    const bodies = consumed.map((r) => parse(r.body));
    for (const body of bodies) {
      // Snapshot consistency: the decision is exactly what the rules give for the recorded limits and usage.
      const before = body.account.usedUnits - body.unitsAccepted;
      const fits = before + body.units <= body.account.monthlyLimit;
      expect(body.decision).toBe(fits ? 'accepted' : 'rejected');
      expect([1, 2, 3, 4]).toContain(body.account.planVersion);
    }
    const counters = await readCounters(ctx, account.id, currentMonth());
    expect(counters.accountUsed).toBe(counters.acceptedSum);
    expect(counters.usersSum).toBe(counters.acceptedSum);

    // Once the final update has returned, every new request sees version 4.
    const next = parse((await consume(ctx, account, userIds[0]!, 5).expect(200)).body);
    expect(next.account).toMatchObject({ planVersion: 4, monthlyLimit: 300 });
  });
});

describe('atomicity under failure', () => {
  it('rolls back counters and history together when the transaction fails midway', async () => {
    const { account, userIds } = await setupScenario(ctx, {
      account: { monthlyLimit: 1_000, perRequestLimit: 100 },
      user: { monthlyLimit: 1_000, perRequestLimit: 100 },
    });
    const user = userIds[0]!;
    await consume(ctx, account, user, 10).expect(200);

    // Inject a database failure on the *last* write of the transaction (the
    // user counter increment), after the history insert and account increment.
    const trigger = `qf_test_fail_${user.replaceAll('-', '')}`;
    await ctx.pool.query(`
      CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated failure'; END $$;
      CREATE TRIGGER ${trigger} AFTER UPDATE ON user_monthly_usage FOR EACH ROW
        WHEN (NEW.user_id = '${user}' AND NEW.used_units <> OLD.used_units) EXECUTE FUNCTION ${trigger}();
    `);
    try {
      const failed = await consume(ctx, account, user, 15, 'doomed-request').expect(500);
      expect(failed.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
      expect(await readCounters(ctx, account.id, currentMonth())).toEqual({ accountUsed: 10, usersSum: 10, acceptedSum: 10 });
      const record = await ctx.pool.query('SELECT 1 FROM usage_requests WHERE account_id = $1 AND request_id = $2', [
        account.id,
        'doomed-request',
      ]);
      expect(record.rowCount).toBe(0);
    } finally {
      await ctx.pool.query(`DROP TRIGGER ${trigger} ON user_monthly_usage; DROP FUNCTION ${trigger}();`);
    }
    // The failed attempt did not consume the requestId: a retry is evaluated fresh.
    const retry = parse((await consume(ctx, account, user, 15, 'doomed-request').expect(200)).body);
    expect(retry).toMatchObject({ decision: 'accepted', replayed: false, account: { usedUnits: 25 } });
  });

  it('refuses inconsistent ledger rows at the database level', async () => {
    const { account, userIds, accountPlanId, userPlanId } = await setupScenario(ctx, {
      account: { monthlyLimit: 100, perRequestLimit: 10 },
      user: { monthlyLimit: 100, perRequestLimit: 10 },
    });
    // A "rejected" record that nevertheless changes usage must be impossible.
    await expect(
      ctx.pool.query(
        `INSERT INTO usage_requests (account_id, user_id, request_id, units, status, rejection_reason, rejection_level,
           usage_month, processed_at, account_plan_id, account_plan_version, account_monthly_limit, account_per_request_limit,
           account_used_before, account_used_after, user_plan_id, user_plan_version, user_monthly_limit, user_per_request_limit,
           user_used_before, user_used_after)
         VALUES ($1, $2, 'forged', 5, 'rejected', 'USER_MONTHLY_LIMIT_EXCEEDED', 'user', '2026-01-01', now(),
           $3, 1, 100, 10, 0, 5, $4, 1, 100, 10, 0, 5)`,
        [account.id, userIds[0], accountPlanId, userPlanId],
      ),
    ).rejects.toThrow(/usage_requests_usage_delta_consistent/);
  });
});
