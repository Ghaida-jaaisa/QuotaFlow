import { setTimeout as sleep } from 'node:timers/promises';
import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Clock } from '../../clock.js';
import type { Database, Executor, Transaction } from '../../db/client.js';
import { isRetryableTransactionError, isUniqueViolation } from '../../db/pgErrors.js';
import {
  accountMonthlyUsage,
  accounts,
  plans,
  usageRequests,
  userMonthlyUsage,
  users,
  type UsageRequestRow,
} from '../../db/schema.js';
import { evaluateConsumption } from '../../domain/evaluate.js';
import { monthOf, monthToDate } from '../../domain/month.js';
import { AppError } from '../../http/errors.js';
import { userNotFound } from '../users/users.service.js';

export interface ConsumeInput {
  accountId: string;
  userId: string;
  units: number;
  requestId: string;
}

export interface ConsumeResult {
  record: UsageRequestRow;
  /** True when this call returned a decision recorded by an earlier call with the same requestId. */
  replayed: boolean;
}

const IDEMPOTENCY_CONSTRAINT = 'usage_requests_account_request_unique';
const MAX_ATTEMPTS = 3;

/**
 * Evaluates and records one consumption request atomically.
 *
 * Concurrency strategy (READ COMMITTED + row locks, fixed lock order):
 *
 *   Before any lock is taken (these run in parallel across requests):
 *   a. Fast-path idempotency lookup: a retry of an already-recorded request
 *      returns immediately without queueing for the account lock.
 *   b. Read the user (ownership check) and both plans in one statement, so the
 *      two plans come from the same snapshot. Any plan update that committed
 *      before this request began is therefore applied.
 *
 *   Critical section (holds the account-month row lock until COMMIT; kept to
 *   as few round trips as possible because it serializes the account):
 *   1. Lock the account's counter row for the UTC month (created on first use).
 *      Every consumption for the same account and month queues here, so the
 *      read-evaluate-write sequence cannot interleave with a competitor.
 *   2. Re-check the requestId under the lock: a concurrent duplicate either
 *      committed while we waited (we see and replay it) or waits behind us.
 *   3. Lock the user's counter row. Lock order is always account -> user,
 *      which rules out deadlocks between consumption transactions.
 *   4. Evaluate the rules (pure function), insert the decision record and, if
 *      accepted, increment both counters in a single statement.
 *
 * The unique constraint on (account_id, request_id) is the final authority on
 * idempotency: it also covers duplicates that straddle a month boundary and
 * therefore lock different counter rows.
 */
export async function consumeUnits(db: Database, clock: Clock, input: ConsumeInput): Promise<ConsumeResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction((tx) => decideInTransaction(tx, clock.now(), input));
    } catch (error) {
      if (isUniqueViolation(error, IDEMPOTENCY_CONSTRAINT)) {
        // A concurrent transaction recorded this requestId first; its decision is authoritative.
        const existing = await findRecordedDecision(db, input.accountId, input.requestId);
        if (existing) {
          return replayOrConflict(existing, input);
        }
      }
      // Not expected with a consistent lock order, but cheap insurance; bounded.
      if (isRetryableTransactionError(error) && attempt < MAX_ATTEMPTS) {
        await sleep(attempt * 10 + Math.floor(Math.random() * 20));
        continue;
      }
      throw error;
    }
  }
}

async function decideInTransaction(tx: Transaction, now: Date, input: ConsumeInput): Promise<ConsumeResult> {
  const month = monthToDate(monthOf(now));

  const earlier = await findRecordedDecision(tx, input.accountId, input.requestId);
  if (earlier) {
    return replayOrConflict(earlier, input);
  }
  const context = await loadPlanContext(tx, input.accountId, input.userId);
  if (!context) {
    throw userNotFound();
  }

  // --- Critical section: the account-month lock is held from here to COMMIT.
  const accountUsedBefore = await lockAccountCounter(tx, input.accountId, month, now);

  const existing = await findRecordedDecision(tx, input.accountId, input.requestId);
  if (existing) {
    return replayOrConflict(existing, input);
  }

  const userUsedBefore = await lockUserCounter(tx, input.accountId, input.userId, month, now);

  const evaluation = evaluateConsumption(
    input.units,
    { ...context.accountLimits, usedUnits: accountUsedBefore },
    { ...context.userLimits, usedUnits: userUsedBefore },
  );
  const consumed = evaluation.status === 'accepted' ? input.units : 0;
  const rejection = evaluation.status === 'rejected' ? evaluation.rejection : null;

  const [record] = await tx
    .insert(usageRequests)
    .values({
      accountId: input.accountId,
      userId: input.userId,
      requestId: input.requestId,
      units: input.units,
      status: evaluation.status,
      rejectionReason: rejection?.reason ?? null,
      rejectionLevel: rejection?.level ?? null,
      usageMonth: month,
      processedAt: now,
      accountPlanId: context.accountLimits.planId,
      accountPlanVersion: context.accountLimits.version,
      accountMonthlyLimit: context.accountLimits.monthlyLimit,
      accountPerRequestLimit: context.accountLimits.perRequestLimit,
      accountUsedBefore,
      accountUsedAfter: accountUsedBefore + consumed,
      userPlanId: context.userLimits.planId,
      userPlanVersion: context.userLimits.version,
      userMonthlyLimit: context.userLimits.monthlyLimit,
      userPerRequestLimit: context.userLimits.perRequestLimit,
      userUsedBefore,
      userUsedAfter: userUsedBefore + consumed,
    })
    .returning();

  if (consumed > 0) {
    await applyToCounters(tx, input, month, now, consumed);
  }
  return { record: record!, replayed: false };
}

/**
 * Upsert that both creates the month's counter row if missing and takes a row
 * lock on it (ON CONFLICT DO UPDATE locks the conflicting row), returning the
 * current value in one round trip.
 */
async function lockAccountCounter(tx: Transaction, accountId: string, month: string, now: Date): Promise<number> {
  const [row] = await tx
    .insert(accountMonthlyUsage)
    .values({ accountId, month, usedUnits: 0, updatedAt: now })
    .onConflictDoUpdate({
      target: [accountMonthlyUsage.accountId, accountMonthlyUsage.month],
      set: { usedUnits: sql`${accountMonthlyUsage.usedUnits}` },
    })
    .returning({ usedUnits: accountMonthlyUsage.usedUnits });
  return row!.usedUnits;
}

async function lockUserCounter(
  tx: Transaction,
  accountId: string,
  userId: string,
  month: string,
  now: Date,
): Promise<number> {
  const [row] = await tx
    .insert(userMonthlyUsage)
    .values({ accountId, userId, month, usedUnits: 0, updatedAt: now })
    .onConflictDoUpdate({
      target: [userMonthlyUsage.userId, userMonthlyUsage.month],
      set: { usedUnits: sql`${userMonthlyUsage.usedUnits}` },
    })
    .returning({ usedUnits: userMonthlyUsage.usedUnits });
  return row!.usedUnits;
}

/** Increments both counters in one statement (one round trip inside the critical section). */
async function applyToCounters(
  tx: Transaction,
  input: ConsumeInput,
  month: string,
  now: Date,
  units: number,
): Promise<void> {
  const result = await tx.execute<{ level: string }>(sql`
    WITH account_update AS (
      UPDATE account_monthly_usage
      SET used_units = used_units + ${units}, updated_at = ${now}
      WHERE account_id = ${input.accountId} AND month = ${month}
      RETURNING 'account' AS level
    ), user_update AS (
      UPDATE user_monthly_usage
      SET used_units = used_units + ${units}, updated_at = ${now}
      WHERE user_id = ${input.userId} AND month = ${month}
      RETURNING 'user' AS level
    )
    SELECT level FROM account_update UNION ALL SELECT level FROM user_update`);
  // Both rows were locked earlier in this transaction, so both must exist;
  // anything else is a bug, and throwing rolls the whole decision back.
  if (result.rows.length !== 2) {
    throw new Error(`Expected to update 2 usage counters, updated ${result.rows.length}`);
  }
}

interface PlanLimits {
  planId: string;
  version: number;
  monthlyLimit: number;
  perRequestLimit: number;
}

const userPlan = alias(plans, 'user_plan');
const accountPlan = alias(plans, 'account_plan');

/**
 * Verifies the user belongs to the authenticated account and resolves both
 * plans in one statement, so the two plans come from the same snapshot.
 */
async function loadPlanContext(
  tx: Transaction,
  accountId: string,
  userId: string,
): Promise<{ accountLimits: PlanLimits; userLimits: PlanLimits } | undefined> {
  const limitsOf = (plan: typeof userPlan | typeof accountPlan) => ({
    planId: plan.id,
    version: plan.version,
    monthlyLimit: plan.monthlyLimit,
    perRequestLimit: plan.perRequestLimit,
  });
  const [row] = await tx
    .select({ userLimits: limitsOf(userPlan), accountLimits: limitsOf(accountPlan) })
    .from(users)
    .innerJoin(userPlan, eq(userPlan.id, users.planId))
    .innerJoin(accounts, eq(accounts.id, users.accountId))
    .innerJoin(accountPlan, eq(accountPlan.id, accounts.planId))
    .where(and(eq(users.id, userId), eq(users.accountId, accountId)))
    .limit(1);
  return row;
}

export async function findRecordedDecision(
  db: Executor,
  accountId: string,
  requestId: string,
): Promise<UsageRequestRow | undefined> {
  const [row] = await db
    .select()
    .from(usageRequests)
    .where(and(eq(usageRequests.accountId, accountId), eq(usageRequests.requestId, requestId)))
    .limit(1);
  return row;
}

/**
 * Same requestId + same payload (userId, units) -> return the original
 * decision verbatim, whatever has changed since. Different payload -> 409.
 */
function replayOrConflict(existing: UsageRequestRow, input: ConsumeInput): ConsumeResult {
  if (existing.userId !== input.userId || existing.units !== input.units) {
    throw new AppError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'This requestId was already used for a different consumption request',
      { requestId: input.requestId, original: { userId: existing.userId, units: existing.units } },
    );
  }
  return { record: existing, replayed: true };
}
