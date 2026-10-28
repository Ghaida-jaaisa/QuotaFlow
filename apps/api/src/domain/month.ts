/** A UTC calendar month in `YYYY-MM` form, as used by the public API. */
export type MonthKey = `${number}-${number}`;

export const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: string): value is MonthKey {
  return MONTH_PATTERN.test(value);
}

/** The UTC month containing `instant`. Never uses the server's local timezone. */
export function monthOf(instant: Date): MonthKey {
  const year = instant.getUTCFullYear();
  const month = String(instant.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}` as MonthKey;
}

/** `2026-10` -> `2026-10-01`, the value stored in Postgres `date` month columns. */
export function monthToDate(month: MonthKey): string {
  return `${month}-01`;
}

/** `2026-10-01` -> `2026-10`. */
export function dateToMonth(isoDate: string): MonthKey {
  const key = isoDate.slice(0, 7);
  if (!isMonthKey(key)) {
    throw new Error(`Not a month date: ${isoDate}`);
  }
  return key;
}

function toIndex(month: MonthKey): number {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  return year * 12 + (mon - 1);
}

function fromIndex(index: number): MonthKey {
  const year = Math.floor(index / 12);
  const month = String((index % 12) + 1).padStart(2, '0');
  return `${year}-${month}` as MonthKey;
}

export function addMonths(month: MonthKey, delta: number): MonthKey {
  return fromIndex(toIndex(month) + delta);
}

export function monthsBetweenInclusive(from: MonthKey, to: MonthKey): number {
  return toIndex(to) - toIndex(from) + 1;
}

/** Inclusive list of months from `from` to `to`, oldest first. */
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const months: MonthKey[] = [];
  for (let index = toIndex(from); index <= toIndex(to); index++) {
    months.push(fromIndex(index));
  }
  return months;
}

/** Half-open UTC instant range [start, end) covering the month. */
export function monthBounds(month: MonthKey): { start: Date; end: Date } {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  return {
    start: new Date(Date.UTC(year, mon - 1, 1)),
    end: new Date(Date.UTC(year, mon, 1)),
  };
}
