import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { getAuth } from '../../http/auth.js';
import { paginationQuerySchema, parseBody, parseQuery, uuidSchema, monthSchema } from '../../http/validate.js';
import { consumeUnits } from './consume.service.js';
import { toDecisionView } from './decision.view.js';
import { listRequestHistory } from './history.service.js';

export const MAX_UNITS_PER_REQUEST = 1_000_000_000;

const consumeSchema = z.strictObject({
  userId: uuidSchema,
  units: z
    .number({ error: 'units must be a number' })
    .int({ error: 'units must be an integer' })
    .positive({ error: 'units must be a positive integer' })
    .max(MAX_UNITS_PER_REQUEST),
  requestId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/, { error: 'requestId may only contain letters, digits, ".", "_", ":" and "-"' }),
});

const historyQuerySchema = paginationQuerySchema.extend({
  userId: uuidSchema.optional(),
  status: z.enum(['accepted', 'rejected']).optional(),
  month: monthSchema.optional(),
});

export function createUsageRouter({ db, clock }: AppDeps): Router {
  const router = Router();

  /**
   * Both accepted and rejected outcomes are 200: the request was evaluated and
   * its decision recorded. HTTP error statuses are reserved for requests that
   * could not be evaluated (validation, auth, unknown user, idempotency conflict).
   */
  router.post('/usage/consume', async (req, res) => {
    const input = parseBody(consumeSchema, req);
    const { record, replayed } = await consumeUnits(db, clock, { ...input, accountId: getAuth(req).accountId });
    res.setHeader('Idempotent-Replayed', String(replayed));
    res.status(200).json({ ...toDecisionView(record), replayed });
  });

  router.get('/usage/requests', async (req, res) => {
    const query = parseQuery(historyQuerySchema, req);
    res.json(await listRequestHistory(db, getAuth(req).accountId, query));
  });

  return router;
}
