import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import type { AppDeps } from './deps.js';
import { requireApiKey } from './http/auth.js';
import { createErrorHandler, notFoundRoute } from './http/errors.js';
import { createHealthRouter } from './http/health.js';
import { createAccountRouter, createProvisioningRouter } from './modules/accounts/accounts.routes.js';
import { createPlansRouter, createPublicPlansRouter } from './modules/plans/plans.routes.js';
import { createUsageRouter } from './modules/usage/usage.routes.js';
import { createUsersRouter } from './modules/users/users.routes.js';

export function createApp(deps: AppDeps, logger: Logger): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback, uniquelocal');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (_req, res, error) => (error || res.statusCode >= 500 ? 'error' : 'info'),
      // Health probes would otherwise dominate the logs.
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
    }),
  );
  app.use(express.json({ limit: '16kb' }));

  app.use(createHealthRouter(deps.db));

  // Public routes: provisioning (optionally admin-gated) and the predefined plan catalogue.
  app.use('/v1', createProvisioningRouter(deps), createPublicPlansRouter(deps));

  // Everything else under /v1 is account-scoped and requires a valid API key.
  const protectedRoutes = express.Router();
  protectedRoutes.use(requireApiKey(deps.db));
  protectedRoutes.use(
    createAccountRouter(deps),
    createUsersRouter(deps),
    createPlansRouter(deps),
    createUsageRouter(deps),
  );
  app.use('/v1', protectedRoutes);

  app.use(notFoundRoute);
  app.use(createErrorHandler(logger));
  return app;
}
