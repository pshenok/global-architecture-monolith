import { defineConfig } from 'drizzle-kit';

/**
 * `pnpm db:generate` diffs src/infrastructure/persistence/schema.ts against the last
 * snapshot and writes a new SQL migration to ./drizzle. Review the SQL in the PR.
 * Non-interactive runs exit with code 2 on rename ambiguity and print the --hints JSON to
 * pass. Never use `drizzle-kit push` against shared databases.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infrastructure/persistence/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
