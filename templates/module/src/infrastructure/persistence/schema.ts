import { index, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * The sample items module's own Postgres schema: the single source of truth for its
 * migrations (`pnpm db:generate` diffs it into SQL under ./drizzle). Only this module may
 * touch these tables; other modules go through its public API, or react to its events.
 */
export const sampleItemsSchema = pgSchema('sample_items');

export const sampleItems = sampleItemsSchema.table(
  'sample_items',
  {
    id: uuid('id').primaryKey(),
    /** A user id of the users module: no foreign key across module boundaries. */
    ownerId: uuid('owner_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [
    // Names are unique per owner: a global key would tell users which names others use.
    unique('sample_items_owner_id_name_key').on(table.ownerId, table.name),
    // (owner_id, id) serves the owner-scoped keyset list: WHERE owner_id = $1 AND id < $2
    index('sample_items_owner_id_id_idx').on(table.ownerId, table.id),
  ],
);

export type SampleItemRow = typeof sampleItems.$inferSelect;
