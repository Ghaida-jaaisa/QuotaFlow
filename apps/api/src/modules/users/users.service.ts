import { and, asc, eq, gt, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Clock } from '../../clock.js';
import type { Database, Executor } from '../../db/client.js';
import { accountMonthlyUsage, accounts, plans, userMonthlyUsage, users } from '../../db/schema.js';
import { DEFAULT_USER_PLAN_CODE } from '../../db/seed.js';
import { monthOf, monthToDate, type MonthKey } from '../../domain/month.js';
import { decodeCursor, toPage, type Page } from '../../http/cursor.js';
import { notFound } from '../../http/errors.js';
import { getPredefinedPlanByCode, resolveAssignablePlan, toPlanView, type PlanView } from '../plans/plans.service.js';
import { usageSnapshot, type UsageSnapshot } from '../usage/usage.views.js';

export interface UserView {
  id: string;
  accountId: string;
  name: string;
  createdAt: string;
  plan: PlanView;
  usage: UsageSnapshot;
}

export interface UserDetailView extends UserView {
  accountUsage: UsageSnapshot;
  /** What the user can actually consume right now once both levels are applied. */
  effective: { maxUnitsPerRequest: number; availableThisMonth: number };
}

export const userNotFound = () => notFound('USER_NOT_FOUND', 'User not found');

/** Ownership check used wherever a user ID arrives from the caller. */
export async function assertUserInAccount(db: Executor, accountId: string, userId: string): Promise<void> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.accountId, accountId)))
    .limit(1);
  if (!row) {
    throw userNotFound();
  }
}

export async function createUser(
  db: Database,
  clock: Clock,
  accountId: string,
  input: { name: string; planId?: string | undefined },
): Promise<UserView> {
  const plan = input.planId
    ? await resolveAssignablePlan(db, accountId, input.planId, 'user')
    : await getPredefinedPlanByCode(db, DEFAULT_USER_PLAN_CODE);
  const now = clock.now();
  const [user] = await db
    .insert(users)
    .values({ accountId, name: input.name, planId: plan.id, createdAt: now, updatedAt: now })
    .returning();
  return {
    id: user!.id,
    accountId: user!.accountId,
    name: user!.name,
    createdAt: user!.createdAt.toISOString(),
    plan: toPlanView(plan),
    usage: usageSnapshot(monthOf(now), plan, 0),
  };
}

/** Lists users with their plan and current-month usage in one query (no N+1). */
export async function listUsers(
  db: Executor,
  clock: Clock,
  accountId: string,
  page: { limit: number; cursor?: string | undefined },
): Promise<Page<UserView>> {
  const month = monthOf(clock.now());
  const cursor = page.cursor ? decodeCursor(page.cursor) : undefined;
  const rows = await db
    .select({ user: users, plan: plans, usedUnits: userMonthlyUsage.usedUnits })
    .from(users)
    .innerJoin(plans, eq(plans.id, users.planId))
    .leftJoin(userMonthlyUsage, and(eq(userMonthlyUsage.userId, users.id), eq(userMonthlyUsage.month, monthToDate(month))))
    .where(
      and(
        eq(users.accountId, accountId),
        cursor
          ? or(gt(users.createdAt, cursor.timestamp), and(eq(users.createdAt, cursor.timestamp), gt(users.id, cursor.id)))
          : undefined,
      ),
    )
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(page.limit + 1);
  return toPage(
    rows,
    page.limit,
    (row) => ({ timestamp: row.user.createdAt, id: row.user.id }),
    (row) => toUserView(row.user, row.plan, month, row.usedUnits),
  );
}

function toUserView(
  user: typeof users.$inferSelect,
  plan: typeof plans.$inferSelect,
  month: MonthKey,
  usedUnits: number | null,
): UserView {
  return {
    id: user.id,
    accountId: user.accountId,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
    plan: toPlanView(plan),
    usage: usageSnapshot(month, plan, usedUnits),
  };
}

const userPlan = alias(plans, 'user_plan');
const accountPlan = alias(plans, 'account_plan');

/** User, both applicable plans and both usage counters for this month, in one query. */
export async function getUserOverview(db: Executor, clock: Clock, accountId: string, userId: string): Promise<UserDetailView> {
  const month = monthOf(clock.now());
  const monthDate = monthToDate(month);
  const [row] = await db
    .select({
      user: users,
      userPlan,
      accountPlan,
      userUsed: userMonthlyUsage.usedUnits,
      accountUsed: accountMonthlyUsage.usedUnits,
    })
    .from(users)
    .innerJoin(userPlan, eq(userPlan.id, users.planId))
    .innerJoin(accounts, eq(accounts.id, users.accountId))
    .innerJoin(accountPlan, eq(accountPlan.id, accounts.planId))
    .leftJoin(userMonthlyUsage, and(eq(userMonthlyUsage.userId, users.id), eq(userMonthlyUsage.month, monthDate)))
    .leftJoin(
      accountMonthlyUsage,
      and(eq(accountMonthlyUsage.accountId, users.accountId), eq(accountMonthlyUsage.month, monthDate)),
    )
    .where(and(eq(users.id, userId), eq(users.accountId, accountId)))
    .limit(1);
  if (!row) {
    throw userNotFound();
  }
  const base = toUserView(row.user, row.userPlan, month, row.userUsed);
  const accountUsage = usageSnapshot(month, row.accountPlan, row.accountUsed);
  return {
    ...base,
    accountUsage,
    effective: {
      maxUnitsPerRequest: Math.min(row.userPlan.perRequestLimit, row.accountPlan.perRequestLimit),
      availableThisMonth: Math.min(base.usage.remaining, accountUsage.remaining),
    },
  };
}

/** Switching plans never touches usage counters, so this month's usage carries over. */
export async function assignUserPlan(
  db: Database,
  clock: Clock,
  accountId: string,
  userId: string,
  planId: string,
): Promise<UserDetailView> {
  await assertUserInAccount(db, accountId, userId);
  const plan = await resolveAssignablePlan(db, accountId, planId, 'user');
  await db
    .update(users)
    .set({ planId: plan.id, updatedAt: clock.now() })
    .where(and(eq(users.id, userId), eq(users.accountId, accountId)));
  return getUserOverview(db, clock, accountId, userId);
}
