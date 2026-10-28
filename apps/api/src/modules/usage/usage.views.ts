import { remainingAllowance } from '../../domain/evaluate.js';
import type { MonthKey } from '../../domain/month.js';

export interface UsageSnapshot {
  month: MonthKey;
  usedUnits: number;
  monthlyLimit: number;
  perRequestLimit: number;
  remaining: number;
}

/** `usedUnits` is null when no counter row exists yet for the month, which means zero usage. */
export function usageSnapshot(
  month: MonthKey,
  limits: { monthlyLimit: number; perRequestLimit: number },
  usedUnits: number | null,
): UsageSnapshot {
  const used = usedUnits ?? 0;
  return {
    month,
    usedUnits: used,
    monthlyLimit: limits.monthlyLimit,
    perRequestLimit: limits.perRequestLimit,
    remaining: remainingAllowance(limits.monthlyLimit, used),
  };
}
