import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { getAuth } from '../../http/auth.js';
import { AppError } from '../../http/errors.js';
import { limitSchema, nameSchema, parseBody, parseParams, parseQuery, uuidSchema } from '../../http/validate.js';
import {
  createCustomPlan,
  getVisiblePlan,
  listPredefinedPlans,
  listVisiblePlans,
  toPlanView,
  updateCustomPlan,
} from './plans.service.js';

const scopeSchema = z.enum(['account', 'user']);
const planParamsSchema = z.object({ planId: uuidSchema });

const createPlanSchema = z.strictObject({
  name: nameSchema,
  scope: scopeSchema,
  monthlyLimit: limitSchema,
  perRequestLimit: limitSchema,
});

// `scope` is intentionally not updatable: entities are already assigned at a fixed level.
const updatePlanSchema = z
  .strictObject({
    name: nameSchema.optional(),
    monthlyLimit: limitSchema.optional(),
    perRequestLimit: limitSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    error: 'Provide at least one of name, monthlyLimit, perRequestLimit',
  });

/** Predefined plans are public catalogue data and need no API key. */
export function createPublicPlansRouter({ db }: AppDeps): Router {
  const router = Router();
  router.get('/plans/predefined', async (req, res) => {
    const { scope } = parseQuery(z.object({ scope: scopeSchema.optional() }), req);
    const rows = await listPredefinedPlans(db, scope);
    res.json({ data: rows.map(toPlanView) });
  });
  return router;
}

export function createPlansRouter({ db, clock }: AppDeps): Router {
  const router = Router();

  router.get('/plans', async (req, res) => {
    const filter = parseQuery(
      z.object({ scope: scopeSchema.optional(), kind: z.enum(['predefined', 'custom']).optional() }),
      req,
    );
    const rows = await listVisiblePlans(db, getAuth(req).accountId, filter);
    res.json({ data: rows.map(toPlanView) });
  });

  router.post('/plans', async (req, res) => {
    const input = parseBody(createPlanSchema, req);
    const plan = await createCustomPlan(db, clock, getAuth(req).accountId, input);
    res.status(201).json(toPlanView(plan));
  });

  router.get('/plans/:planId', async (req, res) => {
    const { planId } = parseParams(planParamsSchema, req);
    const plan = await getVisiblePlan(db, getAuth(req).accountId, planId);
    res.json(toPlanView(plan));
  });

  router.patch('/plans/:planId', async (req, res) => {
    const { planId } = parseParams(planParamsSchema, req);
    const body: unknown = req.body ?? {};
    if (typeof body === 'object' && body !== null && 'scope' in body) {
      throw new AppError(400, 'VALIDATION_ERROR', 'A plan scope cannot be changed', [
        { path: 'scope', message: 'Create a new plan with the desired scope instead' },
      ]);
    }
    const input = parseBody(updatePlanSchema, req);
    const plan = await updateCustomPlan(db, clock, getAuth(req).accountId, planId, input);
    res.json(toPlanView(plan));
  });

  return router;
}
