import { migrationSet } from '@gam/platform';

/** The bookings module's migrations (its `bookings` schema). */
export const BOOKINGS_MIGRATIONS = migrationSet('bookings', new URL('../drizzle', import.meta.url));
