import { migrationSet } from '@gam/platform';

/** The sample items module's migrations (its `sample_items` schema). */
export const SAMPLE_ITEMS_MIGRATIONS = migrationSet(
  'sample-items',
  new URL('../drizzle', import.meta.url),
);
