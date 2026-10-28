import { describe, expect, it } from 'vitest';
import { consume, createAccount, createTestContext, createUser } from '../helpers.js';

describe('persistence', () => {
  it('keeps accounts, usage and idempotency records across an API restart', async () => {
    const first = await createTestContext();
    const account = await createAccount(first);
    const user = await createUser(first, account);
    const original = await consume(first, account, user, 12, 'survives-restart').expect(200);
    // Simulate a process restart: close the HTTP server and every DB connection.
    await first.close();

    const second = await createTestContext();
    try {
      const overview = await second.http.get('/v1/account').set('X-API-Key', account.apiKey).expect(200);
      expect(overview.body.usage.usedUnits).toBe(12);
      const replay = await consume(second, account, user, 12, 'survives-restart').expect(200);
      expect(replay.body).toEqual({ ...original.body, replayed: true });
      const again = await second.http.get('/v1/account').set('X-API-Key', account.apiKey).expect(200);
      expect(again.body.usage.usedUnits).toBe(12);
    } finally {
      await second.close();
    }
  });
});
