import type { Request } from 'express';
import { z } from 'zod';
import { isMonthKey, type MonthKey } from '../domain/month.js';

// Zod errors thrown here are turned into 400 VALIDATION_ERROR by the error handler.
export const parseBody = <T extends z.ZodType>(schema: T, req: Request): z.infer<T> => schema.parse(req.body ?? {});
export const parseQuery = <T extends z.ZodType>(schema: T, req: Request): z.infer<T> => schema.parse(req.query);
export const parseParams = <T extends z.ZodType>(schema: T, req: Request): z.infer<T> => schema.parse(req.params);

export const uuidSchema = z.uuid({ error: 'Must be a valid UUID' });

export const monthSchema = z
  .string()
  .refine(isMonthKey, { error: 'Must be a UTC month in YYYY-MM format' })
  .transform((value) => value as MonthKey);

/** Limits are capped so that sums of usage stay well within a Postgres integer. */
export const MAX_LIMIT = 1_000_000_000;

export const limitSchema = z
  .number({ error: 'Must be a number' })
  .int({ error: 'Must be an integer' })
  .positive({ error: 'Must be a positive integer' })
  .max(MAX_LIMIT, { error: `Must be at most ${MAX_LIMIT}` });

export const nameSchema = z.string().trim().min(1, { error: 'Must not be empty' }).max(100);

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});
