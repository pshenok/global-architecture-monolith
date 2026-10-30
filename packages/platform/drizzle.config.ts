import { defineConfig } from 'drizzle-kit';

/**
 * `pnpm --filter @gam/platform db:generate` diffs src/events/tables.ts against the last
 * snapshot and writes a new SQL migration to ./drizzle. Review the SQL in the PR. Never
 * use `drizzle-kit push` against shared databases.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/events/tables.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
