import { migrationSet } from './migrate.ts';

/** The platform's own migrations (the `events` schema); apply them before any module's. */
export const PLATFORM_MIGRATIONS = migrationSet(
  'platform',
  new URL('../../drizzle', import.meta.url),
);
