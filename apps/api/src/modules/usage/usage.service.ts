import { and, eq, gte, lte } from 'drizzle-orm';
import type { Clock } from '../../clock.js';
import type { Executor } from '../../db/client.js';
import { accountMonthlyUsage, accounts, plans, userMonthlyUsage, users } from '../../db/schema.js';
import { dateToMonth, monthOf, monthRange, monthToDate, type MonthKey } from '../../domain/month.js';
import { remainingAllowance } from '../../domain/evaluate.js';
import { notFound } from '../../http/errors.js';
import { assertUserInAccount, userNotFound } from '../users/users.service.js';

export interface MonthUsageView {
  month: MonthKey;
  usedUnits: number;
  isCurrentMonth: boolean;
  /**
   * Limits of the plan assigned *now*. Only reported for the current month:
   * past months may have been governed by different plans, whose exact limits
   * are preserved per decision in the request history instead.
   */
  monthlyLimit: number | null;
  remaining: number | null;
}

export interface MonthlySeriesView {
  from: MonthKey;
  to: MonthKey;
  data: Array<{ month: MonthKey; usedUnits: number }>;
}

function monthUsageView(month: MonthKey, now: Date, usedUnits: number | null, monthlyLimit: number): MonthUsageView {
  const used = usedUnits ?? 0;
  const isCurrentMonth = month === monthOf(now);
  return {
    month,
    usedUnits: used,
    isCurrentMonth,
    monthlyLimit: isCurrentMonth ? monthlyLimit : null,
    remaining: isCurrentMonth ? remainingAllowance(monthlyLimit, used) : null,
  };
}

export async function getAccountMonthUsage(
  db: Executor,
  clock: Clock,
  accountId: string,
  month: MonthKey,
): Promise<MonthUsageView> {
  const [row] = await db
    .select({ monthlyLimit: plans.monthlyLimit, usedUnits: accountMonthlyUsage.usedUnits })
    .from(accounts)
    .innerJoin(plans, eq(plans.id, accounts.planId))
    .leftJoin(
      accountMonthlyUsage,
      and(eq(accountMonthlyUsage.accountId, accounts.id), eq(accountMonthlyUsage.month, monthToDate(month))),
    )
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!row) {
    throw notFound('NOT_FOUND', 'Account not found');
  }
  return monthUsageView(month, clock.now(), row.usedUnits, row.monthlyLimit);
}

export async function getUserMonthUsage(
  db: Executor,
  clock: Clock,
  accountId: string,
  userId: string,
  month: MonthKey,
): Promise<MonthUsageView> {
  const [row] = await db
    .select({ monthlyLimit: plans.monthlyLimit, usedUnits: userMonthlyUsage.usedUnits })
    .from(users)
    .innerJoin(plans, eq(plans.id, users.planId))
    .leftJoin(userMonthlyUsage, and(eq(userMonthlyUsage.userId, users.id), eq(userMonthlyUsage.month, monthToDate(month))))
    .where(and(eq(users.id, userId), eq(users.accountId, accountId)))
    .limit(1);
  if (!row) {
    throw userNotFound();
  }
  return monthUsageView(month, clock.now(), row.usedUnits, row.monthlyLimit);
}

/** Fills months without a counter row with zero so clients get a gap-free series. */
function toSeries(from: MonthKey, to: MonthKey, rows: Array<{ month: string; usedUnits: number }>): MonthlySeriesView {
  const used = new Map(rows.map((row) => [dateToMonth(row.month), row.usedUnits]));
  return { from, to, data: monthRange(from, to).map((month) => ({ month, usedUnits: used.get(month) ?? 0 })) };
}

export async function getAccountMonthlySeries(
  db: Executor,
  accountId: string,
  from: MonthKey,
  to: MonthKey,
): Promise<MonthlySeriesView> {
  const rows = await db
    .select({ month: accountMonthlyUsage.month, usedUnits: accountMonthlyUsage.usedUnits })
    .from(accountMonthlyUsage)
    .where(
      and(
        eq(accountMonthlyUsage.accountId, accountId),
        gte(accountMonthlyUsage.month, monthToDate(from)),
        lte(accountMonthlyUsage.month, monthToDate(to)),
      ),
    );
  return toSeries(from, to, rows);
}

export async function getUserMonthlySeries(
  db: Executor,
  accountId: string,
  userId: string,
  from: MonthKey,
  to: MonthKey,
): Promise<MonthlySeriesView> {
  await assertUserInAccount(db, accountId, userId);
  const rows = await db
    .select({ month: userMonthlyUsage.month, usedUnits: userMonthlyUsage.usedUnits })
    .from(userMonthlyUsage)
    .where(
      and(
        eq(userMonthlyUsage.userId, userId),
        gte(userMonthlyUsage.month, monthToDate(from)),
        lte(userMonthlyUsage.month, monthToDate(to)),
      ),
    );
  return toSeries(from, to, rows);
}
