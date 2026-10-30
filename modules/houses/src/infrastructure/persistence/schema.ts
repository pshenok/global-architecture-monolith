import { sql } from 'drizzle-orm';
import { bigint, char, index, integer, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The houses module's own Postgres schema (source of truth for `pnpm db:generate`). No
 * other module reads or writes it: they ask HousesApi, or react to its events.
 */
export const housesSchema = pgSchema('houses');

export const houses = housesSchema.table(
  'houses',
  {
    id: uuid('id').primaryKey(),
    /** A user id of the users module: no foreign key across module boundaries. */
    ownerId: uuid('owner_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    addressLine1: text('address_line1').notNull(),
    city: text('city').notNull(),
    countryCode: char('country_code', { length: 2 }).notNull(),
    nightlyPriceMinor: bigint('nightly_price_minor', { mode: 'number' }).notNull(),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    maxGuests: integer('max_guests').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [
    // (filter, id) indexes serve the filtered keyset lists: WHERE owner_id = $1 AND id < $2 ORDER BY id DESC
    index('houses_owner_id_id_idx').on(table.ownerId, table.id),
    index('houses_city_lower_id_idx').on(sql`lower(${table.city})`, table.id),
  ],
);

export type HouseRow = typeof houses.$inferSelect;
