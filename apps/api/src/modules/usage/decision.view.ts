import type { LimitLevel, RejectionReason, UsageRequestRow } from '../../db/schema.js';
import { REJECTION_MESSAGES, remainingAllowance } from '../../domain/evaluate.js';
import { dateToMonth, type MonthKey } from '../../domain/month.js';

export interface LevelDecisionView {
  planId: string;
  planVersion: number;
  monthlyLimit: number;
  perRequestLimit: number;
  /** Usage for the month immediately after this decision was applied. */
  usedUnits: number;
  remaining: number;
}

export interface DecisionView {
  id: string;
  requestId: string;
  decision: 'accepted' | 'rejected';
  userId: string;
  units: number;
  unitsAccepted: number;
  month: MonthKey;
  processedAt: string;
  rejection: {
    code: RejectionReason;
    level: LimitLevel;
    limitType: 'per_request' | 'monthly';
    limit: number;
    available: number | null;
    message: string;
  } | null;
  account: LevelDecisionView;
  user: LevelDecisionView;
}

/**
 * Builds the API representation purely from the stored record. Because each
 * record snapshots the limits and usage it was decided against, a replay or a
 * history read always explains the decision as it was made, regardless of
 * later plan edits.
 */
export function toDecisionView(row: UsageRequestRow): DecisionView {
  return {
    id: row.id,
    requestId: row.requestId,
    decision: row.status,
    userId: row.userId,
    units: row.units,
    unitsAccepted: row.status === 'accepted' ? row.units : 0,
    month: dateToMonth(row.usageMonth),
    processedAt: row.processedAt.toISOString(),
    rejection: rejectionOf(row),
    account: {
      planId: row.accountPlanId,
      planVersion: row.accountPlanVersion,
      monthlyLimit: row.accountMonthlyLimit,
      perRequestLimit: row.accountPerRequestLimit,
      usedUnits: row.accountUsedAfter,
      remaining: remainingAllowance(row.accountMonthlyLimit, row.accountUsedAfter),
    },
    user: {
      planId: row.userPlanId,
      planVersion: row.userPlanVersion,
      monthlyLimit: row.userMonthlyLimit,
      perRequestLimit: row.userPerRequestLimit,
      usedUnits: row.userUsedAfter,
      remaining: remainingAllowance(row.userMonthlyLimit, row.userUsedAfter),
    },
  };
}

function rejectionOf(row: UsageRequestRow): DecisionView['rejection'] {
  if (row.status !== 'rejected' || !row.rejectionReason || !row.rejectionLevel) {
    return null;
  }
  const isAccount = row.rejectionLevel === 'account';
  const limitType = row.rejectionReason.includes('PER_REQUEST') ? 'per_request' : 'monthly';
  const monthlyLimit = isAccount ? row.accountMonthlyLimit : row.userMonthlyLimit;
  const usedBefore = isAccount ? row.accountUsedBefore : row.userUsedBefore;
  return {
    code: row.rejectionReason,
    level: row.rejectionLevel,
    limitType,
    limit:
      limitType === 'per_request' ? (isAccount ? row.accountPerRequestLimit : row.userPerRequestLimit) : monthlyLimit,
    available: limitType === 'monthly' ? remainingAllowance(monthlyLimit, usedBefore) : null,
    message: REJECTION_MESSAGES[row.rejectionReason],
  };
}
