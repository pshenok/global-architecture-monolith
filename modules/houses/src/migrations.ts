import { migrationSet } from '@gam/platform';

/** The houses module's migrations (its `houses` schema). */
export const HOUSES_MIGRATIONS = migrationSet('houses', new URL('../drizzle', import.meta.url));
