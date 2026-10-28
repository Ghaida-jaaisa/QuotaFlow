import { describe, expect, it } from 'vitest';
import { API_KEY_PATTERN, generateApiKey, hashApiKey } from '../../src/modules/accounts/apiKey.js';
import { decodeCursor, encodeCursor } from '../../src/http/cursor.js';

describe('API keys', () => {
  it('generates well-formed, unique, high-entropy keys', () => {
    const keys = new Set(Array.from({ length: 1_000 }, () => generateApiKey().key));
    expect(keys.size).toBe(1_000);
    for (const key of keys) {
      expect(key).toMatch(API_KEY_PATTERN);
    }
  });

  it('stores only a SHA-256 hash and a short non-secret prefix', () => {
    const issued = generateApiKey();
    expect(issued.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.hash).toBe(hashApiKey(issued.key));
    expect(issued.hash).not.toContain(issued.key.slice(3));
    expect(issued.key.startsWith(issued.prefix)).toBe(true);
    expect(issued.prefix).toHaveLength(11);
  });
});

describe('pagination cursors', () => {
  it('round-trips timestamp and id', () => {
    const cursor = { timestamp: new Date('2026-10-01T12:00:00.123Z'), id: '7a1f8a2e-4b8f-4c55-9a59-1f7a5c3e9b10' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects tampered cursors with a validation error', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrowError(/Invalid pagination cursor/);
    const bad = Buffer.from(JSON.stringify({ t: 'yesterday', id: 'x' })).toString('base64url');
    expect(() => decodeCursor(bad)).toThrowError(/Invalid pagination cursor/);
  });
});
