// PostgreSQL SQLSTATE codes the application reacts to.
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_SERIALIZATION_FAILURE = '40001';
export const PG_DEADLOCK_DETECTED = '40P01';

interface PgErrorShape {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

/**
 * Drizzle wraps driver errors (DrizzleQueryError), so walk the `cause` chain
 * to find the original node-postgres error carrying SQLSTATE and constraint.
 */
export function findPgError(error: unknown): { code: string; constraint?: string } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const candidate = current as PgErrorShape;
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        ...(typeof candidate.constraint === 'string' ? { constraint: candidate.constraint } : {}),
      };
    }
    current = candidate.cause;
  }
  return undefined;
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pgError = findPgError(error);
  return pgError?.code === PG_UNIQUE_VIOLATION && pgError.constraint === constraint;
}

export function isRetryableTransactionError(error: unknown): boolean {
  const code = findPgError(error)?.code;
  return code === PG_SERIALIZATION_FAILURE || code === PG_DEADLOCK_DETECTED;
}
