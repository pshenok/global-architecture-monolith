import type { INestApplicationContext } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { DbContext } from '../database/db-context.ts';
import type { Database } from '../database/tokens.ts';
import { type DeliveryOutcome, EventDispatcher } from '../events/dispatcher.ts';
import type { EventType } from '../events/event-type.ts';
import { deliveries, events } from '../events/tables.ts';

/** A Nest application, or a TestApp. */
export type AppContext = INestApplicationContext | { readonly app: INestApplicationContext };

const contextOf = (app: AppContext): INestApplicationContext => ('app' in app ? app.app : app);

/**
 * Delivers every due event (tests run with EVENTS_AUTOSTART=false), again and again until
 * nothing is due, so reactions to reactions run too. Deliveries waiting for a retry stay.
 * Returns how many deliveries it took.
 */
export async function flushEvents(app: AppContext, maxRounds = 20): Promise<number> {
  const dispatcher = contextOf(app).get(EventDispatcher);
  let total = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const taken = await dispatcher.runOnce(1_000);
    total += taken;
    if (taken === 0) return total;
  }
  throw new Error(`flushEvents: still delivering after ${maxRounds} rounds (an event loop?)`);
}

/**
 * Publishes `payload` as if its producer had, with a delivery to `subscriber` only, then
 * delivers it right away. Tests of a consumer use it instead of driving the producer.
 */
export async function deliverEvent<E extends EventType>(
  context: AppContext,
  options: {
    readonly subscriber: string;
    readonly event: E;
    readonly aggregateId: string;
    readonly payload: z.input<E['schema']>;
    /** Pretend this is a later attempt (1-based). */
    readonly attempt?: number;
  },
): Promise<{ readonly eventId: string; readonly outcome: DeliveryOutcome }> {
  const app = contextOf(context);
  const db = app.get(DbContext);
  const host = app.get<TransactionHost<TransactionalAdapterDrizzleOrm<Database>>>(TransactionHost);
  const eventId = uuidv7();
  await host.withTransaction(async () => {
    await db.tx.insert(events).values({
      id: eventId,
      type: options.event.type,
      producer: options.event.producer,
      aggregateId: options.aggregateId,
      occurredAt: new Date(),
      payload: options.payload,
    });
    await db.tx.insert(deliveries).values({
      subscriber: options.subscriber,
      eventId,
      type: options.event.type,
      attempts: (options.attempt ?? 1) - 1,
    });
  });
  const outcome = await app
    .get(EventDispatcher)
    .deliverNext({ subscriber: options.subscriber, eventId });
  return { eventId, outcome };
}

/** An event as stored, with who it is (or was) to be delivered to. */
export interface RecordedEvent {
  readonly id: string;
  readonly type: string;
  readonly producer: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly requestId: string | null;
  readonly deliveries: readonly {
    readonly subscriber: string;
    readonly status: string;
    readonly attempts: number;
    readonly lastError: string | null;
  }[];
}

/** The events recorded so far (of one type, when given), oldest first. */
export async function recordedEvents(
  app: AppContext,
  type?: string,
): Promise<readonly RecordedEvent[]> {
  const db = contextOf(app).get(DbContext).tx;
  const rows = await db.select().from(events).orderBy(events.id);
  const all = await db.select().from(deliveries);
  return rows
    .filter((row) => type === undefined || row.type === type)
    .map((row) => ({
      id: row.id,
      type: row.type,
      producer: row.producer,
      aggregateId: row.aggregateId,
      payload: row.payload,
      requestId: row.requestId,
      deliveries: all
        .filter((delivery) => delivery.eventId === row.id)
        .map(({ subscriber, status, attempts, lastError }) => ({
          subscriber,
          status,
          attempts,
          lastError,
        }))
        .sort((a, b) => a.subscriber.localeCompare(b.subscriber)),
    }));
}
