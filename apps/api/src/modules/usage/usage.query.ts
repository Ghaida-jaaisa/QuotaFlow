import { z } from 'zod';
import type { Clock } from '../../clock.js';
import { addMonths, monthOf, monthsBetweenInclusive, type MonthKey } from '../../domain/month.js';
import { monthSchema } from '../../http/validate.js';

export const MAX_SERIES_MONTHS = 36;

export const monthQuerySchema = z.object({ month: monthSchema.optional() });

export const seriesQuerySchema = z
  .object({ from: monthSchema.optional(), to: monthSchema.optional() })
  .refine(({ from, to }) => !from || !to || monthsBetweenInclusive(from, to) >= 1, {
    error: '`from` must not be after `to`',
    path: ['from'],
  })
  .refine(({ from, to }) => !from || !to || monthsBetweenInclusive(from, to) <= MAX_SERIES_MONTHS, {
    error: `A range may span at most ${MAX_SERIES_MONTHS} months`,
    path: ['from'],
  });

/** Defaults: `to` = current UTC month, `from` = 11 months before `to` (a 12-month window). */
export function resolveSeriesRange(
  query: z.infer<typeof seriesQuerySchema>,
  clock: Clock,
): { from: MonthKey; to: MonthKey } {
  const to = query.to ?? (query.from ? addMonths(query.from, 11) : monthOf(clock.now()));
  const from = query.from ?? addMonths(to, -11);
  return { from, to };
}
