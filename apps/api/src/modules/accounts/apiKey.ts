import { createHash, randomBytes } from 'node:crypto';

const API_KEY_PREFIX = 'qf_';
/** `qf_` + 32 random bytes in base64url (43 chars): 256 bits of entropy. */
export const API_KEY_PATTERN = /^qf_[A-Za-z0-9_-]{43}$/;

export interface IssuedApiKey {
  /** Raw secret. Returned to the caller exactly once and never persisted. */
  key: string;
  hash: string;
  /** Non-secret display prefix, e.g. `qf_AbCd1234`. */
  prefix: string;
}

export function generateApiKey(): IssuedApiKey {
  const key = API_KEY_PREFIX + randomBytes(32).toString('base64url');
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 11) };
}

/**
 * A fast hash (SHA-256) is appropriate here, unlike for passwords: the key is
 * 256 bits of CSPRNG output, so brute-forcing a leaked hash is infeasible, and
 * a deterministic hash allows an indexed lookup on every request.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
