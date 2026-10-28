import { describe, expect, it } from 'vitest';
import { addMonths, dateToMonth, isMonthKey, monthBounds, monthOf, monthRange, monthToDate } from '../../src/domain/month.js';

describe('UTC month helpers', () => {
  it('assigns instants to their UTC month regardless of the local timezone', () => {
    expect(monthOf(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10');
    expect(monthOf(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11');
    // 01:00 on Nov 1 in UTC+02:00 is still October in UTC.
    expect(monthOf(new Date('2026-11-01T01:00:00+02:00'))).toBe('2026-10');
  });

  it('validates YYYY-MM strictly', () => {
    expect(isMonthKey('2026-01')).toBe(true);
    expect(isMonthKey('2026-12')).toBe(true);
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-01', '2026/01', '2026-01-01', '']) {
      expect(isMonthKey(bad)).toBe(false);
    }
  });

  it('converts between month keys and first-of-month dates', () => {
    expect(monthToDate('2026-02')).toBe('2026-02-01');
    expect(dateToMonth('2026-02-01')).toBe('2026-02');
  });

  it('adds months across year boundaries', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', -11)).toBe('2025-11');
  });

  it('builds inclusive ranges', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthRange('2026-05', '2026-05')).toEqual(['2026-05']);
  });

  it('computes half-open UTC bounds, including leap February', () => {
    const { start, end } = monthBounds('2028-02');
    expect(start.toISOString()).toBe('2028-02-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });
});
