import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consume,
  createTestContext,
  decisionResponseSchema,
  setupScenario,
  TestClock,
  type TestAccount,
  type TestContext,
} from '../helpers.js';

// A frozen clock: every request shares one processed_at, so stable ordering
// must come from the id tie-breaker in the keyset.
const clock = new TestClock(new Date('2026-04-15T08:00:00.000Z'));
let ctx: TestContext;
let account: TestAccount;
let alice: string;
let bob: string;

beforeAll(async () => {
  ctx = await createTestContext({ clock });
  const scenario = await setupScenario(
    ctx,
    { account: { monthlyLimit: 10_000, perRequestLimit: 100 }, user: { monthlyLimit: 1_000, perRequestLimit: 20 } },
    2,
  );
  account = scenario.account;
  [alice, bob] = scenario.userIds as [string, string];
  for (let i = 0; i < 9; i++) {
    // Every third request is rejected (25 > per-request limit of 20).
    await consume(ctx, account, i % 2 === 0 ? alice : bob, i % 3 === 0 ? 25 : 5, `hist-${i}`).expect(200);
  }
  clock.set('2026-05-02T08:00:00.000Z');
  await consume(ctx, account, alice, 5, 'hist-may').expect(200);
});
afterAll(() => ctx.close());

async function collectPages(query: Record<string, string | number>): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res: Response = await ctx.http
      .get('/v1/usage/requests')
      .query({ ...query, ...(cursor ? { cursor } : {}) })
      .set('X-API-Key', account.apiKey)
      .expect(200);
    for (const item of res.body.data) {
      decisionResponseSchema.omit({ replayed: true }).parse(item);
      ids.push(item.requestId);
    }
    cursor = res.body.nextCursor;
    pages++;
  } while (cursor);
  return { ids, pages };
}

describe('request history', () => {
  it('pages through every record exactly once, newest first', async () => {
    const { ids, pages } = await collectPages({ limit: 4 });
    expect(pages).toBe(3);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect(ids[0]).toBe('hist-may');
  });

  it('returns the same order on every read', async () => {
    const first = await collectPages({ limit: 3 });
    const second = await collectPages({ limit: 7 });
    expect(second.ids).toEqual(first.ids);
  });

  it('filters by status, user and month', async () => {
    const rejected = await collectPages({ status: 'rejected', limit: 100 });
    expect(rejected.ids.sort()).toEqual(['hist-0', 'hist-3', 'hist-6']);
    const bobs = await collectPages({ userId: bob, limit: 100 });
    expect(bobs.ids.sort()).toEqual(['hist-1', 'hist-3', 'hist-5', 'hist-7']);
    const may = await collectPages({ month: '2026-05', limit: 100 });
    expect(may.ids).toEqual(['hist-may']);
    const aprilAccepted = await collectPages({ month: '2026-04', status: 'accepted', limit: 100 });
    expect(aprilAccepted.ids).toHaveLength(6);
  });

  it('returns an empty page (not an error) for a valid month with no activity', async () => {
    const res = await ctx.http.get('/v1/usage/requests?month=2019-01').set('X-API-Key', account.apiKey).expect(200);
    expect(res.body).toEqual({ data: [], nextCursor: null });
  });

  it('validates pagination and filters', async () => {
    for (const query of ['limit=0', 'limit=500', 'cursor=%%%', 'status=maybe', 'userId=abc']) {
      const res = await ctx.http.get(`/v1/usage/requests?${query}`).set('X-API-Key', account.apiKey).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    await ctx.http.get(`/v1/usage/requests?userId=${crypto.randomUUID()}`).set('X-API-Key', account.apiKey).expect(404);
  });
});
