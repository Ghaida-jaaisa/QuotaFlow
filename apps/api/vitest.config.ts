import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Read TEST_DATABASE_URL from the repository-root .env unless already exported
// (loadEnvFile never overrides variables that are already set).
const rootEnvFile = path.resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    env: testDatabaseUrl ? { TEST_DATABASE_URL: testDatabaseUrl } : {},
    // Each test file opens its own small pool; cap parallelism to stay well
    // under Postgres' default max_connections (100).
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
