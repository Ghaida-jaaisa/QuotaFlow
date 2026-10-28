import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required (e.g. postgres://user:pass@host:5432/db)' })
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// connection string'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // When set, POST /v1/accounts requires a matching X-Admin-Token header.
  // When empty, account provisioning is self-service (open sign-up).
  ADMIN_TOKEN: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined))
    .refine((value) => value === undefined || value.length >= 16, 'ADMIN_TOKEN must be at least 16 characters'),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    // Fail loudly at startup instead of running with a half-valid configuration.
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}
