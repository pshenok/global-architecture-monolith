import { BOOKINGS_MIGRATIONS } from '@gam/bookings';
import { HOUSES_MIGRATIONS } from '@gam/houses';
import { type MigrationSet, PLATFORM_MIGRATIONS } from '@gam/platform';
import { USERS_MIGRATIONS } from '@gam/users';

/** Every migration set of the app, in the order they apply: the platform first. */
export const MIGRATIONS: readonly MigrationSet[] = [
  PLATFORM_MIGRATIONS,
  USERS_MIGRATIONS,
  HOUSES_MIGRATIONS,
  BOOKINGS_MIGRATIONS,
];
