import { Clock, IdGenerator } from '@gam/kernel';
import { context, propagation } from '@opentelemetry/api';
import type { z } from 'zod';
import { currentRequestId } from '../context/request-context.ts';
import type { DbContext } from '../database/db-context.ts';
import type { EventType } from './event-type.ts';
import type { EventRegistry } from './registry.ts';
import { deliveries, events } from './tables.ts';

/** Largest JSON payload: the events table refuses anything bigger. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** The W3C traceparent of the active span, when tracing is on. */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/**
 * Records events in the transaction of the change that caused them (ADR-0005): an event
 * exists if and only if its change committed, together with one delivery per module that
 * subscribes to it. The EventDispatcher delivers them after the commit.
 *
 * Each module gets its own Outbox from `EventsModule.forFeature({ module, publish: true })`
 * and may publish only its own event types. Call it from an infrastructure adapter of a
 * domain-named port, inside UnitOfWork.run:
 *
 *   deleted(house: House) {
 *     return this.outbox.add(HOUSE_DELETED, house.id, { houseId: house.id, ownerId: house.ownerId });
 *   }
 */
export class Outbox {
  constructor(
    private readonly db: DbContext,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly registry: EventRegistry,
    /** The module this outbox publishes for. */
    readonly module: string,
  ) {}

  /**
   * Throws, rolling the change back, outside a transaction, for an event another module
   * owns, for an aggregate id that is not 1..128 chars, or for a payload that its schema
   * refuses, that does not survive JSON, or that is over 64 KiB.
   */
  async add<E extends EventType>(
    event: E,
    aggregateId: string,
    payload: z.input<E['schema']>,
  ): Promise<void> {
    if (!this.db.inTransaction()) {
      throw new Error(
        `Outbox.add(${event.type}) outside UnitOfWork.run(): an event must commit with its change`,
      );
    }
    if (event.producer !== this.module) {
      throw new Error(`${this.module} cannot publish ${event.type}: ${event.producer} owns it`);
    }
    if (aggregateId.length < 1 || aggregateId.length > 128) {
      throw new Error(`${event.type}: the aggregate id must be 1..128 characters`);
    }
    const parsed = event.schema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`${event.type}: invalid payload: ${parsed.error.message}`);
    }
    const json = JSON.stringify(parsed.data);
    if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) {
      throw new Error(`${event.type}: payload of ${Buffer.byteLength(json)} bytes is over 64 KiB`);
    }
    const stored: unknown = JSON.parse(json);
    if (!event.schema.safeParse(stored).success) {
      throw new Error(
        `${event.type}: the payload does not survive JSON (use strings for ids and times)`,
      );
    }
    const id = this.ids.newId();
    await this.db.tx.insert(events).values({
      id,
      type: event.type,
      producer: event.producer,
      aggregateId,
      occurredAt: this.clock.now(),
      payload: stored,
      requestId: currentRequestId() ?? null,
      traceparent: currentTraceparent(),
    });
    const subscribers = this.registry.subscribersOf(event.type);
    if (subscribers.length > 0) {
      await this.db.tx
        .insert(deliveries)
        .values(subscribers.map((subscriber) => ({ subscriber, eventId: id, type: event.type })));
    }
  }
}
