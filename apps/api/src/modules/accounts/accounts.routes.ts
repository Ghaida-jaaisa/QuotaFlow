import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { getAuth, requireAdminTokenIfConfigured } from '../../http/auth.js';
import { nameSchema, parseBody, parseQuery, uuidSchema } from '../../http/validate.js';
import { monthOf } from '../../domain/month.js';
import { getAccountMonthlySeries, getAccountMonthUsage } from '../usage/usage.service.js';
import { monthQuerySchema, resolveSeriesRange, seriesQuerySchema } from '../usage/usage.query.js';
import { assignAccountPlan, createAccount, getAccountOverview } from './accounts.service.js';

const createAccountSchema = z.strictObject({ name: nameSchema, planId: uuidSchema.optional() });
const assignPlanSchema = z.strictObject({ planId: uuidSchema });

/** POST /v1/accounts: provisioning, gated by ADMIN_TOKEN when configured. */
export function createProvisioningRouter({ db, clock, adminToken }: AppDeps): Router {
  const router = Router();
  router.post('/accounts', requireAdminTokenIfConfigured(adminToken), async (req, res) => {
    const input = parseBody(createAccountSchema, req);
    const { account, apiKey } = await createAccount(db, clock, input);
    // The only time the raw key is ever returned.
    res.status(201).setHeader('Cache-Control', 'no-store').json({ ...account, apiKey });
  });
  return router;
}

/** Routes for the authenticated account ("/account" is always the caller's own account). */
export function createAccountRouter({ db, clock }: AppDeps): Router {
  const router = Router();

  router.get('/account', async (req, res) => {
    res.json(await getAccountOverview(db, clock, getAuth(req).accountId));
  });

  router.put('/account/plan', async (req, res) => {
    const { planId } = parseBody(assignPlanSchema, req);
    res.json(await assignAccountPlan(db, clock, getAuth(req).accountId, planId));
  });

  router.get('/account/usage', async (req, res) => {
    const { month } = parseQuery(monthQuerySchema, req);
    res.json(await getAccountMonthUsage(db, clock, getAuth(req).accountId, month ?? monthOf(clock.now())));
  });

  router.get('/account/usage/monthly', async (req, res) => {
    const { from, to } = resolveSeriesRange(parseQuery(seriesQuerySchema, req), clock);
    res.json(await getAccountMonthlySeries(db, getAuth(req).accountId, from, to));
  });

  return router;
}
