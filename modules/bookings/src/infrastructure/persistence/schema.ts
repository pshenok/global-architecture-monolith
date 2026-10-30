import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  date,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The bookings module's own Postgres schema (source of truth for `pnpm db:generate`).
 *
 * The no-overlap rule is an exclusion constraint added by the hand-written migration
 * `*_no_overlap` (drizzle-kit cannot express EXCLUDE):
 *   EXCLUDE USING gist (house_id WITH =, daterange(check_in, check_out, '[)') WITH &&)
 *   WHERE (status = 'CONFIRMED')
 */
export const bookingsSchema = pgSchema('bookings');

export const bookings = bookingsSchema.table(
  'bookings',
  {
    id: uuid('id').primaryKey(),
    /** A house id of the houses module: no foreign key across module boundaries. */
    houseId: uuid('house_id').notNull(),
    /** A user id of the users module. */
    guestId: uuid('guest_id').notNull(),
    /** The house owner's user id, snapshotted at booking time (owners never change). */
    hostId: uuid('host_id').notNull(),
    checkIn: date('check_in', { mode: 'string' }).notNull(),
    checkOut: date('check_out', { mode: 'string' }).notNull(),
    guests: integer('guests').notNull(),
    totalPriceMinor: bigint('total_price_minor', { mode: 'number' }).notNull(),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    status: text('status', { enum: ['CONFIRMED', 'CANCELLED'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    // (filter, id) indexes serve the filtered keyset lists: WHERE house_id = $1 AND id < $2 ORDER BY id DESC
    index('bookings_house_id_id_idx').on(table.houseId, table.id),
    index('bookings_guest_id_id_idx').on(table.guestId, table.id),
    index('bookings_host_id_id_idx').on(table.hostId, table.id),
    check('bookings_dates_check', sql`${table.checkIn} < ${table.checkOut}`),
    check('bookings_status_check', sql`${table.status} in ('CONFIRMED', 'CANCELLED')`),
    check('bookings_guests_check', sql`${table.guests} > 0`),
  ],
);

export type BookingRow = typeof bookings.$inferSelect;

/** Name of the exclusion constraint created by the `no_overlap` migration. */
export const NO_OVERLAP_CONSTRAINT = 'bookings_no_overlap';
