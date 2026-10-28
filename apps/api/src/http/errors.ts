import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_JSON'
  | 'PAYLOAD_TOO_LARGE'
  | 'MISSING_API_KEY'
  | 'INVALID_API_KEY'
  | 'MISSING_ADMIN_TOKEN'
  | 'INVALID_ADMIN_TOKEN'
  | 'NOT_FOUND'
  | 'USER_NOT_FOUND'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_SCOPE_MISMATCH'
  | 'PLAN_NAME_TAKEN'
  | 'PREDEFINED_PLAN_READ_ONLY'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (code: Extract<ErrorCode, `${string}NOT_FOUND`>, message: string) =>
  new AppError(404, code, message);

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

function body(code: ErrorCode, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export const notFoundRoute: RequestHandler = (_req, res) => {
  res.status(404).json(body('NOT_FOUND', 'Route not found'));
};

interface BodyParserError {
  type?: string;
  status?: number;
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, _next) => {
    if (error instanceof AppError) {
      res.status(error.status).json(body(error.code, error.message, error.details));
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json(body('VALIDATION_ERROR', 'Request validation failed', formatIssues(error)));
      return;
    }
    const parserError = error as BodyParserError;
    if (parserError?.type === 'entity.parse.failed') {
      res.status(400).json(body('INVALID_JSON', 'Request body is not valid JSON'));
      return;
    }
    if (parserError?.type === 'entity.too.large') {
      res.status(413).json(body('PAYLOAD_TOO_LARGE', 'Request body is too large'));
      return;
    }
    // Unexpected failure: log full detail server-side, return nothing internal to the client.
    (req.log ?? logger).error({ err: error }, 'unhandled request error');
    res.status(500).json(body('INTERNAL_ERROR', 'An unexpected error occurred'));
  };
}

export function formatIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}
