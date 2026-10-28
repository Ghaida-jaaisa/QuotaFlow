import { plans } from './schema.js';
import type { Executor } from './client.js';

/**
 * Predefined plans. They are configuration data stored in the database; the
 * application never branches on these values. Seeding is idempotent: existing
 * rows (matched by `code`) are left untouched, so re-running initialization
 * never alters limits that accounts are already using.
 */
export const PREDEFINED_PLANS = [
  { code: 'starter', scope: 'account', name: 'Starter', monthlyLimit: 10_000, perRequestLimit: 100 },
  { code: 'pro', scope: 'account', name: 'Pro', monthlyLimit: 100_000, perRequestLimit: 1_000 },
  { code: 'basic', scope: 'user', name: 'Basic', monthlyLimit: 1_000, perRequestLimit: 20 },
  { code: 'premium', scope: 'user', name: 'Premium', monthlyLimit: 5_000, perRequestLimit: 100 },
] as const;

export const DEFAULT_ACCOUNT_PLAN_CODE = 'starter';
export const DEFAULT_USER_PLAN_CODE = 'basic';

export async function seedPredefinedPlans(db: Executor): Promise<number> {
  const inserted = await db
    .insert(plans)
    .values(PREDEFINED_PLANS.map((plan) => ({ ...plan })))
    .onConflictDoNothing({ target: plans.code })
    .returning({ id: plans.id });
  return inserted.length;
}
