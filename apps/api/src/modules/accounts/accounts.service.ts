import { and, eq } from 'drizzle-orm';
import type { Clock } from '../../clock.js';
import type { Database, Executor } from '../../db/client.js';
import { accountMonthlyUsage, accounts, plans } from '../../db/schema.js';
import { DEFAULT_ACCOUNT_PLAN_CODE } from '../../db/seed.js';
import { monthOf, monthToDate } from '../../domain/month.js';
import { AppError, notFound } from '../../http/errors.js';
import { getPredefinedPlanByCode, resolveAssignablePlan, toPlanView, type PlanView } from '../plans/plans.service.js';
import { usageSnapshot, type UsageSnapshot } from '../usage/usage.views.js';
import { generateApiKey } from './apiKey.js';

export interface AccountView {
  id: string;
  name: string;
  apiKeyPrefix: string;
  createdAt: string;
  plan: PlanView;
  usage: UsageSnapshot;
}

export async function createAccount(
  db: Database,
  clock: Clock,
  input: { name: string; planId?: string | undefined },
): Promise<{ account: AccountView; apiKey: string }> {
  const plan = input.planId
    ? await resolveNewAccountPlan(db, input.planId)
    : await getPredefinedPlanByCode(db, DEFAULT_ACCOUNT_PLAN_CODE);
  const apiKey = generateApiKey();
  const now = clock.now();
  const [account] = await db
    .insert(accounts)
    .values({
      name: input.name,
      apiKeyHash: apiKey.hash,
      apiKeyPrefix: apiKey.prefix,
      planId: plan.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return {
    account: {
      id: account!.id,
      name: account!.name,
      apiKeyPrefix: account!.apiKeyPrefix,
      createdAt: account!.createdAt.toISOString(),
      plan: toPlanView(plan),
      usage: usageSnapshot(monthOf(now), plan, 0),
    },
    apiKey: apiKey.key,
  };
}

/** A brand-new account owns no custom plans, so only predefined account plans are valid here. */
async function resolveNewAccountPlan(db: Executor, planId: string) {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!plan || plan.accountId !== null) {
    throw notFound('PLAN_NOT_FOUND', 'Plan not found');
  }
  if (plan.scope !== 'account') {
    throw new AppError(422, 'PLAN_SCOPE_MISMATCH', `Plan ${plan.id} is a user plan and cannot be assigned to an account`);
  }
  return plan;
}

/** Account, its current plan and this month's usage in a single query. */
export async function getAccountOverview(db: Executor, clock: Clock, accountId: string): Promise<AccountView> {
  const month = monthOf(clock.now());
  const [row] = await db
    .select({ account: accounts, plan: plans, usedUnits: accountMonthlyUsage.usedUnits })
    .from(accounts)
    .innerJoin(plans, eq(plans.id, accounts.planId))
    .leftJoin(
      accountMonthlyUsage,
      and(eq(accountMonthlyUsage.accountId, accounts.id), eq(accountMonthlyUsage.month, monthToDate(month))),
    )
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!row) {
    // The account was authenticated moments ago; it can only vanish if deleted concurrently.
    throw notFound('NOT_FOUND', 'Account not found');
  }
  return {
    id: row.account.id,
    name: row.account.name,
    apiKeyPrefix: row.account.apiKeyPrefix,
    createdAt: row.account.createdAt.toISOString(),
    plan: toPlanView(row.plan),
    usage: usageSnapshot(month, row.plan, row.usedUnits),
  };
}

/** Switching plans never touches usage counters, so this month's usage carries over. */
export async function assignAccountPlan(db: Database, clock: Clock, accountId: string, planId: string): Promise<AccountView> {
  const plan = await resolveAssignablePlan(db, accountId, planId, 'account');
  await db.update(accounts).set({ planId: plan.id, updatedAt: clock.now() }).where(eq(accounts.id, accountId));
  return getAccountOverview(db, clock, accountId);
}
