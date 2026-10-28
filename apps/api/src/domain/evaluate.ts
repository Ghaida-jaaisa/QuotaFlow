import type { LimitLevel, RejectionReason } from '../db/schema.js';

export interface LevelState {
  monthlyLimit: number;
  perRequestLimit: number;
  /** Units already consumed at this level in the current UTC month. */
  usedUnits: number;
}

export interface Rejection {
  reason: RejectionReason;
  level: LimitLevel;
  limitType: 'per_request' | 'monthly';
  limit: number;
  /** Remaining monthly allowance at the rejecting level; null for per-request rejections. */
  available: number | null;
}

export type Evaluation = { status: 'accepted' } | { status: 'rejected'; rejection: Rejection };

/** Remaining allowance is clamped at zero: a lowered limit never yields a negative value. */
export function remainingAllowance(monthlyLimit: number, usedUnits: number): number {
  return Math.max(0, monthlyLimit - usedUnits);
}

/**
 * Pure decision function. Rules are checked in a fixed precedence so that a
 * request violating several limits always reports the same reason:
 *
 *   1. account per-request limit
 *   2. user per-request limit
 *   3. account monthly allowance
 *   4. user monthly allowance
 *
 * Per-request limits come first because they are properties of the request
 * itself (retrying later can never help), while monthly limits depend on state.
 * Account precedes user because it is the shared, outer boundary.
 */
export function evaluateConsumption(units: number, account: LevelState, user: LevelState): Evaluation {
  if (units > account.perRequestLimit) {
    return rejected('ACCOUNT_PER_REQUEST_LIMIT_EXCEEDED', 'account', 'per_request', account.perRequestLimit, null);
  }
  if (units > user.perRequestLimit) {
    return rejected('USER_PER_REQUEST_LIMIT_EXCEEDED', 'user', 'per_request', user.perRequestLimit, null);
  }
  const accountRemaining = remainingAllowance(account.monthlyLimit, account.usedUnits);
  if (units > accountRemaining) {
    return rejected('ACCOUNT_MONTHLY_LIMIT_EXCEEDED', 'account', 'monthly', account.monthlyLimit, accountRemaining);
  }
  const userRemaining = remainingAllowance(user.monthlyLimit, user.usedUnits);
  if (units > userRemaining) {
    return rejected('USER_MONTHLY_LIMIT_EXCEEDED', 'user', 'monthly', user.monthlyLimit, userRemaining);
  }
  return { status: 'accepted' };
}

function rejected(
  reason: RejectionReason,
  level: LimitLevel,
  limitType: Rejection['limitType'],
  limit: number,
  available: number | null,
): Evaluation {
  return { status: 'rejected', rejection: { reason, level, limitType, limit, available } };
}

export const REJECTION_MESSAGES: Record<RejectionReason, string> = {
  ACCOUNT_PER_REQUEST_LIMIT_EXCEEDED: "Requested units exceed the account plan's per-request limit.",
  USER_PER_REQUEST_LIMIT_EXCEEDED: "Requested units exceed the user plan's per-request limit.",
  ACCOUNT_MONTHLY_LIMIT_EXCEEDED: "Requested units exceed the account's remaining monthly allowance.",
  USER_MONTHLY_LIMIT_EXCEEDED: "Requested units exceed the user's remaining monthly allowance.",
};
