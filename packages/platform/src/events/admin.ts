import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../database/tokens.ts';
import { RETENTION_DAYS } from './dispatcher.ts';
import { deliveries } from './tables.ts';

/** Deliveries of one (subscriber, event type) pair, as `events:status` shows them. */
export interface DeliveryStats {
  readonly subscriber: string;
  readonly type: string;
  readonly pending: number;
  /** Pending and due now (not waiting for a retry). */
  readonly due: number;
  readonly dead: number;
  /** Delivered within DELIVERED_KEPT_DAYS. */
  readonly delivered: number;
  /** When the oldest pending delivery's event happened, or null. */
  readonly oldestPending: Date | null;
  /** The error of the most recently failed delivery, or null. */
  readonly lastError: string | null;
}

/**
 * Operator actions on the event deliveries (pnpm events:*), over the platform's own
 * tables. Each takes a (subscriber module, event type) pair.
 */
export class EventsAdmin {
  constructor(private readonly db: Database) {}

  async status(): Promise<readonly DeliveryStats[]> {
    const result = await this.db.execute<{
      subscriber: string;
      type: string;
      pending: number;
      due: number;
      dead: number;
      delivered: number;
      oldest_pending: Date | string | null;
      last_error: string | null;
    }>(sql`
      select d.subscriber, d.type,
        count(*) filter (where d.status = 'pending')::int as pending,
        count(*) filter (where d.status = 'pending' and d.available_at <= now())::int as due,
        count(*) filter (where d.status = 'dead')::int as dead,
        count(*) filter (where d.status = 'delivered')::int as delivered,
        min(e.occurred_at) filter (where d.status = 'pending') as oldest_pending,
        (array_agg(d.last_error order by d.available_at desc)
          filter (where d.last_error is not null and d.status <> 'delivered'))[1] as last_error
      from events.deliveries d join events.events e on e.id = d.event_id
      group by d.subscriber, d.type
      order by d.subscriber, d.type`);
    return result.rows.map((row) => ({
      subscriber: row.subscriber,
      type: row.type,
      pending: row.pending,
      due: row.due,
      dead: row.dead,
      delivered: row.delivered,
      oldestPending: row.oldest_pending === null ? null : new Date(row.oldest_pending),
      lastError: row.last_error,
    }));
  }

  /** Dead letters of the pair become due again, attempts reset. Returns how many. */
  async redrive(subscriber: string, type: string): Promise<number> {
    const rows = await this.db
      .update(deliveries)
      .set({ status: 'pending', attempts: 0, availableAt: sql`now()`, lastError: null })
      .where(
        and(
          eq(deliveries.subscriber, subscriber),
          eq(deliveries.type, type),
          eq(deliveries.status, 'dead'),
        ),
      )
      .returning({ eventId: deliveries.eventId });
    return rows.length;
  }

  /**
   * Delivers the pair's events since `since` again (or for the first time, to a module
   * that subscribed after they were published): due now, attempts reset, delivered ones
   * included. Events older than RETENTION_DAYS may be gone. Returns how many.
   */
  async replay(subscriber: string, type: string, since: Date): Promise<number> {
    const result = await this.db.execute<{ event_id: string }>(sql`
      insert into events.deliveries (subscriber, event_id, type)
      select ${subscriber}, e.id, e.type from events.events e
      where e.type = ${type} and e.occurred_at >= ${since.toISOString()}::timestamptz
      on conflict (subscriber, event_id) do update
        set status = 'pending', attempts = 0, available_at = now(), last_error = null,
            delivered_at = null
      returning event_id`);
    return result.rows.length;
  }

  /**
   * Discards the pair's dead letters; with `retired` (no module handles the pair any more,
   * so the dispatcher never leases them) its pending deliveries too. Returns how many.
   */
  async drop(subscriber: string, type: string, { retired = false } = {}): Promise<number> {
    const rows = await this.db
      .delete(deliveries)
      .where(
        and(
          eq(deliveries.subscriber, subscriber),
          eq(deliveries.type, type),
          inArray(deliveries.status, retired ? ['dead', 'pending'] : ['dead']),
        ),
      )
      .returning({ eventId: deliveries.eventId });
    return rows.length;
  }

  /** The earliest `since` a replay can still reach. */
  static oldestReplayable(now: Date): Date {
    return new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  }
}
