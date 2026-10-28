import { and, asc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Clock } from '../../clock.js';
import type { Executor } from '../../db/client.js';
import { isUniqueViolation } from '../../db/pgErrors.js';
import { plans, type PlanRow, type PlanScope } from '../../db/schema.js';
import { AppError, notFound } from '../../http/errors.js';

export interface PlanView {
  id: string;
  code: string | null;
  name: string;
  scope: PlanScope;
  kind: 'predefined' | 'custom';
  monthlyLimit: number;
  perRequestLimit: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toPlanView(plan: PlanRow): PlanView {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    scope: plan.scope,
    kind: plan.accountId === null ? 'predefined' : 'custom',
    monthlyLimit: plan.monthlyLimit,
    perRequestLimit: plan.perRequestLimit,
    version: plan.version,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

/** A plan is visible to an account if it is predefined or owned by that account. */
const visibleTo = (accountId: string): SQL => or(isNull(plans.accountId), eq(plans.accountId, accountId))!;

const PLAN_NOT_FOUND_MESSAGE = 'Plan not found';

export async function listPredefinedPlans(db: Executor, scope?: PlanScope): Promise<PlanRow[]> {
  return db
    .select()
    .from(plans)
    .where(and(isNull(plans.accountId), scope ? eq(plans.scope, scope) : undefined))
    .orderBy(asc(plans.scope), asc(plans.monthlyLimit));
}

export async function listVisiblePlans(
  db: Executor,
  accountId: string,
  filter: { scope?: PlanScope; kind?: 'predefined' | 'custom' },
): Promise<PlanRow[]> {
  const ownership =
    filter.kind === 'predefined'
      ? isNull(plans.accountId)
      : filter.kind === 'custom'
        ? eq(plans.accountId, accountId)
        : visibleTo(accountId);
  return db
    .select()
    .from(plans)
    .where(and(ownership, filter.scope ? eq(plans.scope, filter.scope) : undefined))
    .orderBy(asc(plans.scope), asc(plans.createdAt), asc(plans.id));
}

/** Another account's plan is reported exactly like a nonexistent one. */
export async function getVisiblePlan(db: Executor, accountId: string, planId: string): Promise<PlanRow> {
  const [plan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), visibleTo(accountId)))
    .limit(1);
  if (!plan) {
    throw notFound('PLAN_NOT_FOUND', PLAN_NOT_FOUND_MESSAGE);
  }
  return plan;
}

/** Resolves a plan the account may assign at the given level (user plans to users, account plans to accounts). */
export async function resolveAssignablePlan(
  db: Executor,
  accountId: string,
  planId: string,
  scope: PlanScope,
): Promise<PlanRow> {
  const plan = await getVisiblePlan(db, accountId, planId);
  if (plan.scope !== scope) {
    throw new AppError(422, 'PLAN_SCOPE_MISMATCH', `Plan ${plan.id} is a ${plan.scope} plan and cannot be assigned to a ${scope}`);
  }
  return plan;
}

export async function getPredefinedPlanByCode(db: Executor, code: string): Promise<PlanRow> {
  const [plan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.code, code), isNull(plans.accountId)))
    .limit(1);
  if (!plan) {
    // Seeding runs before the API starts, so this means initialization was skipped.
    throw new Error(`Predefined plan "${code}" is missing; run database migrations and seeding`);
  }
  return plan;
}

export interface CreatePlanInput {
  name: string;
  scope: PlanScope;
  monthlyLimit: number;
  perRequestLimit: number;
}

function planNameTaken(name: string): AppError {
  return new AppError(409, 'PLAN_NAME_TAKEN', `A custom plan named "${name}" already exists for this scope`);
}

export async function createCustomPlan(
  db: Executor,
  clock: Clock,
  accountId: string,
  input: CreatePlanInput,
): Promise<PlanRow> {
  const now = clock.now();
  try {
    const [plan] = await db
      .insert(plans)
      .values({ ...input, accountId, createdAt: now, updatedAt: now })
      .returning();
    return plan!;
  } catch (error) {
    if (isUniqueViolation(error, 'plans_account_scope_name_unique')) {
      throw planNameTaken(input.name);
    }
    throw error;
  }
}

export interface UpdatePlanInput {
  name?: string | undefined;
  monthlyLimit?: number | undefined;
  perRequestLimit?: number | undefined;
}

/**
 * Updates are a single atomic UPDATE. A consumption request reads both plans
 * in one statement at the start of its transaction, so every request sent
 * after this update has committed (i.e. after the API returned 200) is
 * evaluated against the new limits, and records the plan version it used.
 * Usage counters are not touched: lowering a limit below current usage simply
 * leaves zero remaining.
 */
export async function updateCustomPlan(
  db: Executor,
  clock: Clock,
  accountId: string,
  planId: string,
  input: UpdatePlanInput,
): Promise<PlanRow> {
  const changes = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  try {
    const [updated] = await db
      .update(plans)
      .set({ ...changes, version: sql`${plans.version} + 1`, updatedAt: clock.now() })
      .where(and(eq(plans.id, planId), eq(plans.accountId, accountId)))
      .returning();
    if (updated) {
      return updated;
    }
  } catch (error) {
    if (input.name !== undefined && isUniqueViolation(error, 'plans_account_scope_name_unique')) {
      throw planNameTaken(input.name);
    }
    throw error;
  }
  // Nothing updated: distinguish a predefined plan (visible, read-only) from an unknown/foreign one.
  const plan = await getVisiblePlan(db, accountId, planId);
  if (plan.accountId === null) {
    throw new AppError(403, 'PREDEFINED_PLAN_READ_ONLY', 'Predefined plans cannot be modified; create a custom plan instead');
  }
  throw notFound('PLAN_NOT_FOUND', PLAN_NOT_FOUND_MESSAGE);
}
