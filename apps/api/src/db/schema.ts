import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const planScope = pgEnum('plan_scope', ['account', 'user']);
export const decisionStatus = pgEnum('decision_status', ['accepted', 'rejected']);
export const limitLevel = pgEnum('limit_level', ['account', 'user']);
export const rejectionReason = pgEnum('rejection_reason', [
  'ACCOUNT_PER_REQUEST_LIMIT_EXCEEDED',
  'USER_PER_REQUEST_LIMIT_EXCEEDED',
  'ACCOUNT_MONTHLY_LIMIT_EXCEEDED',
  'USER_MONTHLY_LIMIT_EXCEEDED',
]);

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Plans are either predefined (no owner, has a stable `code`) or custom
 * (owned by exactly one account). `version` increments on every update and is
 * snapshotted into each decision so history stays explainable.
 */
export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').references((): AnyPgColumn => accounts.id, { onDelete: 'cascade' }),
    code: text('code').unique(),
    scope: planScope('scope').notNull(),
    name: text('name').notNull(),
    monthlyLimit: integer('monthly_limit').notNull(),
    perRequestLimit: integer('per_request_limit').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Target for the (plan_id, plan_scope) composite foreign keys below.
    unique('plans_id_scope_unique').on(t.id, t.scope),
    unique('plans_account_scope_name_unique').on(t.accountId, t.scope, t.name),
    check('plans_monthly_limit_positive', sql`${t.monthlyLimit} > 0`),
    check('plans_per_request_limit_positive', sql`${t.perRequestLimit} > 0`),
    check('plans_version_positive', sql`${t.version} > 0`),
    check('plans_predefined_xor_owned', sql`(${t.accountId} IS NULL) = (${t.code} IS NOT NULL)`),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    // SHA-256 (hex) of the API key. The raw key is never stored.
    apiKeyHash: text('api_key_hash').notNull().unique(),
    // Non-secret leading characters, so humans can tell keys apart.
    apiKeyPrefix: text('api_key_prefix').notNull(),
    planId: uuid('plan_id').notNull(),
    // Constant column that lets the composite FK prove the plan is an account plan.
    planScope: planScope('plan_scope').notNull().default('account'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'accounts_plan_fk',
      columns: [t.planId, t.planScope],
      foreignColumns: [plans.id, plans.scope],
    }).onDelete('restrict'),
    check('accounts_plan_scope_is_account', sql`${t.planScope} = 'account'`),
    index('accounts_plan_id_idx').on(t.planId),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    planId: uuid('plan_id').notNull(),
    planScope: planScope('plan_scope').notNull().default('user'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [
    // Target for (account_id, user_id) FKs: usage rows can only reference a
    // user together with the account that actually owns it.
    unique('users_account_id_id_unique').on(t.accountId, t.id),
    foreignKey({
      name: 'users_plan_fk',
      columns: [t.planId, t.planScope],
      foreignColumns: [plans.id, plans.scope],
    }).onDelete('restrict'),
    check('users_plan_scope_is_user', sql`${t.planScope} = 'user'`),
    index('users_account_created_idx').on(t.accountId, t.createdAt, t.id),
    index('users_plan_id_idx').on(t.planId),
  ],
);

/** Materialized monthly counter per account. `month` is the first day of a UTC month. */
export const accountMonthlyUsage = pgTable(
  'account_monthly_usage',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    month: date('month', { mode: 'string' }).notNull(),
    usedUnits: integer('used_units').notNull().default(0),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'account_monthly_usage_pk', columns: [t.accountId, t.month] }),
    check('account_monthly_usage_non_negative', sql`${t.usedUnits} >= 0`),
    check('account_monthly_usage_first_of_month', sql`EXTRACT(DAY FROM ${t.month}) = 1`),
  ],
);

/** Materialized monthly counter per user. */
export const userMonthlyUsage = pgTable(
  'user_monthly_usage',
  {
    userId: uuid('user_id').notNull(),
    accountId: uuid('account_id').notNull(),
    month: date('month', { mode: 'string' }).notNull(),
    usedUnits: integer('used_units').notNull().default(0),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'user_monthly_usage_pk', columns: [t.userId, t.month] }),
    foreignKey({
      name: 'user_monthly_usage_user_fk',
      columns: [t.accountId, t.userId],
      foreignColumns: [users.accountId, users.id],
    }).onDelete('cascade'),
    check('user_monthly_usage_non_negative', sql`${t.usedUnits} >= 0`),
    check('user_monthly_usage_first_of_month', sql`EXTRACT(DAY FROM ${t.month}) = 1`),
  ],
);

/**
 * Append-only decision log. Every evaluated consumption request (accepted or
 * rejected) is recorded with the limits and usage it was decided against, so
 * later plan edits cannot change the meaning of a historical decision.
 */
export const usageRequests = pgTable(
  'usage_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull(),
    userId: uuid('user_id').notNull(),
    requestId: text('request_id').notNull(),
    units: integer('units').notNull(),
    status: decisionStatus('status').notNull(),
    rejectionReason: rejectionReason('rejection_reason'),
    rejectionLevel: limitLevel('rejection_level'),
    usageMonth: date('usage_month', { mode: 'string' }).notNull(),
    processedAt: timestamptz('processed_at').notNull(),

    accountPlanId: uuid('account_plan_id')
      .notNull()
      .references(() => plans.id),
    accountPlanVersion: integer('account_plan_version').notNull(),
    accountMonthlyLimit: integer('account_monthly_limit').notNull(),
    accountPerRequestLimit: integer('account_per_request_limit').notNull(),
    accountUsedBefore: integer('account_used_before').notNull(),
    accountUsedAfter: integer('account_used_after').notNull(),

    userPlanId: uuid('user_plan_id')
      .notNull()
      .references(() => plans.id),
    userPlanVersion: integer('user_plan_version').notNull(),
    userMonthlyLimit: integer('user_monthly_limit').notNull(),
    userPerRequestLimit: integer('user_per_request_limit').notNull(),
    userUsedBefore: integer('user_used_before').notNull(),
    userUsedAfter: integer('user_used_after').notNull(),
  },
  (t) => [
    // The idempotency guarantee: one logical operation per request ID per account.
    unique('usage_requests_account_request_unique').on(t.accountId, t.requestId),
    foreignKey({
      name: 'usage_requests_user_fk',
      columns: [t.accountId, t.userId],
      foreignColumns: [users.accountId, users.id],
    }).onDelete('cascade'),
    index('usage_requests_account_history_idx').on(t.accountId, t.processedAt.desc(), t.id.desc()),
    index('usage_requests_user_history_idx').on(t.userId, t.processedAt.desc(), t.id.desc()),
    check('usage_requests_units_positive', sql`${t.units} > 0`),
    check('usage_requests_first_of_month', sql`EXTRACT(DAY FROM ${t.usageMonth}) = 1`),
    check(
      'usage_requests_rejection_consistent',
      sql`(${t.status} = 'accepted' AND ${t.rejectionReason} IS NULL AND ${t.rejectionLevel} IS NULL)
        OR (${t.status} = 'rejected' AND ${t.rejectionReason} IS NOT NULL AND ${t.rejectionLevel} IS NOT NULL)`,
    ),
    // Rejected requests consume nothing; accepted requests consume exactly `units` at both levels.
    check(
      'usage_requests_usage_delta_consistent',
      sql`${t.accountUsedAfter} = ${t.accountUsedBefore} + CASE WHEN ${t.status} = 'accepted' THEN ${t.units} ELSE 0 END
        AND ${t.userUsedAfter} = ${t.userUsedBefore} + CASE WHEN ${t.status} = 'accepted' THEN ${t.units} ELSE 0 END`,
    ),
  ],
);

export type PlanRow = typeof plans.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type UsageRequestRow = typeof usageRequests.$inferSelect;
export type PlanScope = (typeof planScope.enumValues)[number];
export type RejectionReason = (typeof rejectionReason.enumValues)[number];
export type LimitLevel = (typeof limitLevel.enumValues)[number];
