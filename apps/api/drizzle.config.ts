import { defineConfig } from 'drizzle-kit';

// Only used by `drizzle-kit generate`, which diffs the schema against
// committed migrations and needs no database connection.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
