import { describe, expect, it } from 'vitest';
import { evaluateConsumption, remainingAllowance, type LevelState } from '../../src/domain/evaluate.js';

// The worked example from the specification.
const account = (usedUnits = 0): LevelState => ({ monthlyLimit: 10_000, perRequestLimit: 100, usedUnits });
const user = (usedUnits = 0): LevelState => ({ monthlyLimit: 1_000, perRequestLimit: 20, usedUnits });

describe('evaluateConsumption', () => {
  it('accepts a request that satisfies every limit', () => {
    expect(evaluateConsumption(10, account(), user())).toEqual({ status: 'accepted' });
  });

  it('rejects 25 units by the user per-request limit even though the account allows 100', () => {
    expect(evaluateConsumption(25, account(), user())).toEqual({
      status: 'rejected',
      rejection: { reason: 'USER_PER_REQUEST_LIMIT_EXCEEDED', level: 'user', limitType: 'per_request', limit: 20, available: null },
    });
  });

  it('rejects by the shared account allowance when only 5 account units remain', () => {
    const result = evaluateConsumption(10, account(9_995), user());
    expect(result).toEqual({
      status: 'rejected',
      rejection: { reason: 'ACCOUNT_MONTHLY_LIMIT_EXCEEDED', level: 'account', limitType: 'monthly', limit: 10_000, available: 5 },
    });
  });

  it('rejects by the account per-request limit', () => {
    const result = evaluateConsumption(150, account(), { monthlyLimit: 1_000, perRequestLimit: 500, usedUnits: 0 });
    expect(result).toMatchObject({ status: 'rejected', rejection: { reason: 'ACCOUNT_PER_REQUEST_LIMIT_EXCEEDED', level: 'account' } });
  });

  it('rejects by the user monthly allowance', () => {
    const result = evaluateConsumption(10, account(), user(995));
    expect(result).toMatchObject({
      status: 'rejected',
      rejection: { reason: 'USER_MONTHLY_LIMIT_EXCEEDED', level: 'user', limit: 1_000, available: 5 },
    });
  });

  it('accepts a request that lands exactly on both monthly limits', () => {
    expect(evaluateConsumption(5, { ...account(9_995) }, { ...user(995) })).toEqual({ status: 'accepted' });
    expect(evaluateConsumption(20, account(), user(980))).toEqual({ status: 'accepted' });
  });

  it('accepts exactly the per-request limit and rejects one more', () => {
    expect(evaluateConsumption(20, account(), user()).status).toBe('accepted');
    expect(evaluateConsumption(21, account(), user()).status).toBe('rejected');
  });

  describe('precedence when several rules fail', () => {
    // Every rule fails for 200 units: both per-request limits and both monthly allowances.
    const exhaustedAccount = { monthlyLimit: 100, perRequestLimit: 50, usedUnits: 100 };
    const exhaustedUser = { monthlyLimit: 100, perRequestLimit: 10, usedUnits: 100 };

    it('reports account per-request first', () => {
      expect(evaluateConsumption(200, exhaustedAccount, exhaustedUser)).toMatchObject({
        rejection: { reason: 'ACCOUNT_PER_REQUEST_LIMIT_EXCEEDED' },
      });
    });
    it('then user per-request', () => {
      expect(evaluateConsumption(20, exhaustedAccount, exhaustedUser)).toMatchObject({
        rejection: { reason: 'USER_PER_REQUEST_LIMIT_EXCEEDED' },
      });
    });
    it('then account monthly', () => {
      expect(evaluateConsumption(5, exhaustedAccount, exhaustedUser)).toMatchObject({
        rejection: { reason: 'ACCOUNT_MONTHLY_LIMIT_EXCEEDED' },
      });
    });
    it('then user monthly', () => {
      expect(evaluateConsumption(5, { ...exhaustedAccount, usedUnits: 0 }, exhaustedUser)).toMatchObject({
        rejection: { reason: 'USER_MONTHLY_LIMIT_EXCEEDED' },
      });
    });
  });

  it('rejects everything once usage is above a lowered limit and reports zero available', () => {
    const result = evaluateConsumption(1, { monthlyLimit: 50, perRequestLimit: 10, usedUnits: 80 }, user());
    expect(result).toMatchObject({ rejection: { reason: 'ACCOUNT_MONTHLY_LIMIT_EXCEEDED', available: 0 } });
  });
});

describe('remainingAllowance', () => {
  it('is the difference while under the limit', () => {
    expect(remainingAllowance(100, 40)).toBe(60);
  });
  it('is zero at the limit and never negative above it', () => {
    expect(remainingAllowance(100, 100)).toBe(0);
    expect(remainingAllowance(100, 250)).toBe(0);
  });
});
