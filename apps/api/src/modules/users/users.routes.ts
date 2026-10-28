import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { monthOf } from '../../domain/month.js';
import { getAuth } from '../../http/auth.js';
import { nameSchema, paginationQuerySchema, parseBody, parseParams, parseQuery, uuidSchema } from '../../http/validate.js';
import { getUserMonthlySeries, getUserMonthUsage } from '../usage/usage.service.js';
import { monthQuerySchema, resolveSeriesRange, seriesQuerySchema } from '../usage/usage.query.js';
import { assignUserPlan, createUser, getUserOverview, listUsers } from './users.service.js';

const createUserSchema = z.strictObject({ name: nameSchema, planId: uuidSchema.optional() });
const assignPlanSchema = z.strictObject({ planId: uuidSchema });
const userParamsSchema = z.object({ userId: uuidSchema });

export function createUsersRouter({ db, clock }: AppDeps): Router {
  const router = Router();

  router.post('/users', async (req, res) => {
    const input = parseBody(createUserSchema, req);
    res.status(201).json(await createUser(db, clock, getAuth(req).accountId, input));
  });

  router.get('/users', async (req, res) => {
    const page = parseQuery(paginationQuerySchema, req);
    res.json(await listUsers(db, clock, getAuth(req).accountId, page));
  });

  router.get('/users/:userId', async (req, res) => {
    const { userId } = parseParams(userParamsSchema, req);
    res.json(await getUserOverview(db, clock, getAuth(req).accountId, userId));
  });

  router.put('/users/:userId/plan', async (req, res) => {
    const { userId } = parseParams(userParamsSchema, req);
    const { planId } = parseBody(assignPlanSchema, req);
    res.json(await assignUserPlan(db, clock, getAuth(req).accountId, userId, planId));
  });

  router.get('/users/:userId/usage', async (req, res) => {
    const { userId } = parseParams(userParamsSchema, req);
    const { month } = parseQuery(monthQuerySchema, req);
    res.json(await getUserMonthUsage(db, clock, getAuth(req).accountId, userId, month ?? monthOf(clock.now())));
  });

  router.get('/users/:userId/usage/monthly', async (req, res) => {
    const { userId } = parseParams(userParamsSchema, req);
    const { from, to } = resolveSeriesRange(parseQuery(seriesQuerySchema, req), clock);
    res.json(await getUserMonthlySeries(db, getAuth(req).accountId, userId, from, to));
  });

  return router;
}
