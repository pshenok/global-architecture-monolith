import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The platform's own Postgres schema (source of truth for its migrations, `pnpm --filter
 * @gam/platform db:generate`). Modules never read it; the kit's Outbox writes it inside
 * their transactions and the EventDispatcher delivers from it.
 */
export const eventsSchema = pgSchema('events');

/** Every published event, kept RETENTION_DAYS for replays once its deliveries are done. */
export const events = eventsSchema.table(
  'events',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    producer: text('producer').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 }).notNull(),
    payload: jsonb('payload').notNull(),
    requestId: text('request_id'),
    traceparent: text('traceparent'),
  },
  (table) => [
    index('events_type_occurred_at_idx').on(table.type, table.occurredAt),
    index('events_occurred_at_idx').on(table.occurredAt),
    check('events_payload_size_check', sql`octet_length(${table.payload}::text) <= 65536`),
  ],
);

/** One row per (subscribing module, event): what is due, retrying, done or dead. */
export const deliveries = eventsSchema.table(
  'deliveries',
  {
    subscriber: text('subscriber').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    status: text('status', { enum: ['pending', 'delivered', 'dead'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /**
     * Full precision on purpose: the column is compared with now(), and a value rounded to
     * milliseconds can land after the now() of the transaction that looks for it.
     */
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    primaryKey({ name: 'deliveries_pkey', columns: [table.subscriber, table.eventId] }),
    index('deliveries_due_idx')
      .on(table.availableAt, table.eventId)
      .where(sql`${table.status} = 'pending'`),
    index('deliveries_subscriber_type_status_idx').on(table.subscriber, table.type, table.status),
    index('deliveries_event_id_idx').on(table.eventId),
    check('deliveries_status_check', sql`${table.status} in ('pending', 'delivered', 'dead')`),
  ],
);

export type DeliveryStatus = (typeof deliveries.$inferSelect)['status'];
