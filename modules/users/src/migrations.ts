import { migrationSet } from '@gam/platform';

/** The users module's migrations (its `users` schema). */
export const USERS_MIGRATIONS = migrationSet('users', new URL('../drizzle', import.meta.url));
