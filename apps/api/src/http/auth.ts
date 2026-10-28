import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts } from '../db/schema.js';
import { API_KEY_PATTERN, hashApiKey } from '../modules/accounts/apiKey.js';
import { AppError } from './errors.js';

export const API_KEY_HEADER = 'x-api-key';
export const ADMIN_TOKEN_HEADER = 'x-admin-token';

export interface AuthContext {
  accountId: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Resolves the calling account solely from the API key. Account IDs supplied
 * anywhere in the request are never used for authorization. No caching: a
 * revoked or rotated key must stop working immediately.
 */
export function requireApiKey(db: Database): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const raw = req.header(API_KEY_HEADER);
    if (raw === undefined || raw.trim() === '') {
      throw new AppError(401, 'MISSING_API_KEY', 'Provide an API key in the X-API-Key header');
    }
    // Malformed and unknown keys get the same response so callers learn nothing.
    if (!API_KEY_PATTERN.test(raw)) {
      throw new AppError(401, 'INVALID_API_KEY', 'The API key is invalid');
    }
    const [account] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.apiKeyHash, hashApiKey(raw)))
      .limit(1);
    if (!account) {
      throw new AppError(401, 'INVALID_API_KEY', 'The API key is invalid');
    }
    req.auth = { accountId: account.id };
    next();
  };
}

export function getAuth(req: Request): AuthContext {
  if (!req.auth) {
    // Indicates a route was mounted without requireApiKey: a programming error.
    throw new Error('Authenticated route reached without auth context');
  }
  return req.auth;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Gate for provisioning. With no ADMIN_TOKEN configured, provisioning is open. */
export function requireAdminTokenIfConfigured(adminToken: string | undefined): RequestHandler {
  const expected = adminToken === undefined ? undefined : digest(adminToken);
  return (req, _res, next) => {
    if (expected === undefined) {
      next();
      return;
    }
    const provided = req.header(ADMIN_TOKEN_HEADER);
    if (!provided) {
      throw new AppError(401, 'MISSING_ADMIN_TOKEN', 'Account provisioning requires the X-Admin-Token header');
    }
    // Compare fixed-length digests in constant time.
    if (!timingSafeEqual(digest(provided), expected)) {
      throw new AppError(403, 'INVALID_ADMIN_TOKEN', 'The admin token is invalid');
    }
    next();
  };
}
