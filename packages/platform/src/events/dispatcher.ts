import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type Type,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner, ModuleRef } from '@nestjs/core';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { and, eq, sql } from 'drizzle-orm';
import { CLS_ID, ClsService } from 'nestjs-cls';
import { enterEventDelivery } from '../auth/actor-context.ts';
import { CONFIG } from '../config/config.ts';
import { DbContext } from '../database/db-context.ts';
import type { Database } from '../database/tokens.ts';
import type { EventsConfig } from './config.ts';
import { handledEventOf } from './on-event.ts';
import { EventRegistry } from './registry.ts';
import { classifyFailure, MAX_ATTEMPTS, retryDelayMs } from './retry.ts';
import { deliveries } from './tables.ts';

/** Days an event stays for `events:replay` once all its deliveries are done. */
export const RETENTION_DAYS = 21;
/** Days a delivered delivery stays visible to `events:status`. */
export const DELIVERED_KEPT_DAYS = 7;
const PURGE_EVERY_MS = 60 * 60_000;

/** What became of one claimed delivery. */
export type DeliveryOutcome = 'none' | 'delivered' | 'retry' | 'dead';

interface ClaimedRow extends Record<string, unknown> {
  subscriber: string;
  event_id: string;
  attempts: number;
  type: string;
  producer: string;
  aggregate_id: string;
  occurred_at: Date;
  payload: unknown;
  request_id: string | null;
  traceparent: string | null;
}

/** A delivery that cannot succeed however often it is tried. */
class Undeliverable extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** Waits for `work` at most `ms`; calls `onTimeout` when it is still running then. */
export async function drain(
  work: Promise<unknown> | undefined,
  ms: number,
  onTimeout: () => void,
): Promise<void> {
  if (!work) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  const done = work.then(
    () => 'done' as const,
    () => 'done' as const,
  );
  const result = await Promise.race([done, timeout]);
  clearTimeout(timer);
  if (result === 'timeout') onTimeout();
}

/**
 * Delivers events to the modules that subscribe to them (ADR-0005), in this process.
 *
 * Each delivery runs in its own transaction: it claims the due row (FOR UPDATE SKIP
 * LOCKED, so replicas never take the same one), calls the module's @OnEvent handler in a
 * fresh request context that acts as the module itself (currentService(),
 * currentEvent()), and marks the row delivered. The handler's writes and the mark commit
 * together, so an event takes effect once per subscriber; a crash rolls both back and
 * the row is due again. A failed handler is retried with backoff (1 s doubling to 5 min)
 * or, when it cannot succeed, after MAX_ATTEMPTS, kept as a dead letter.
 */
@Injectable()
export class EventDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('EventDispatcher');
  private timer: NodeJS.Timeout | undefined;
  private purgeTimer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;
  private failures = 0;

  constructor(
    private readonly registry: EventRegistry,
    private readonly moduleRef: ModuleRef,
    private readonly discovery: DiscoveryService,
    private readonly db: DbContext,
    private readonly host: TransactionHost<TransactionalAdapterDrizzleOrm<Database>>,
    private readonly cls: ClsService,
    @Inject(CONFIG) private readonly config: EventsConfig,
  ) {}

  /** Resolves the handlers; fails boot on an @OnEvent provider that no feature lists. */
  onApplicationBootstrap(): void {
    this.assertEveryHandlerListed();
    this.registry.seal(this.moduleRef);
    if (!this.config.EVENTS_AUTOSTART) return;
    if (this.registry.subscriptions().length > 0) this.schedule(0);
    this.purgeTimer = setInterval(() => {
      this.purge().catch((error: unknown) =>
        this.logger.warn(`cannot purge old events: ${String(error)}`),
      );
    }, PURGE_EVERY_MS);
    this.purgeTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.purgeTimer);
    await drain(this.inFlight, this.config.EVENTS_DRAIN_MS, () =>
      this.logger.warn('stopped with a delivery in flight; it rolls back and is due again'),
    );
  }

  /** Processes due deliveries one by one, at most `limit`; returns how many it took. */
  async runOnce(limit = this.config.EVENTS_BATCH): Promise<number> {
    let taken = 0;
    while (taken < limit && !this.stopped) {
      if ((await this.deliverNext()) === 'none') break;
      taken += 1;
    }
    return taken;
  }

  /**
   * Claims one due delivery (the oldest, or exactly `only`) and processes it. Never throws
   * for a handler failure; throws when the database cannot be reached.
   */
  deliverNext(only?: {
    readonly subscriber: string;
    readonly eventId: string;
  }): Promise<DeliveryOutcome> {
    return this.cls.run({ ifNested: 'override' }, async () => {
      let claimed: ClaimedRow | undefined;
      try {
        return await this.host.withTransaction(async () => {
          claimed = await this.claim(only);
          if (!claimed) return 'none' as const;
          await this.handle(claimed);
          await this.db.tx
            .update(deliveries)
            .set({
              status: 'delivered',
              attempts: claimed.attempts + 1,
              deliveredAt: sql`now()`,
              lastError: null,
            })
            .where(this.keyOf(claimed));
          return 'delivered' as const;
        });
      } catch (error) {
        if (!claimed) throw error;
        return this.recordFailure(claimed, error);
      }
    });
  }

  private async claim(
    only: { readonly subscriber: string; readonly eventId: string } | undefined,
  ): Promise<ClaimedRow | undefined> {
    const which = only
      ? sql`d.subscriber = ${only.subscriber} and d.event_id = ${only.eventId}`
      : sql`true`;
    const result = await this.db.tx.execute<ClaimedRow>(sql`
      select d.subscriber, d.event_id, d.attempts, e.type, e.producer, e.aggregate_id,
             e.occurred_at, e.payload, e.request_id, e.traceparent
      from events.deliveries d join events.events e on e.id = d.event_id
      where d.status = 'pending' and d.available_at <= now() and ${which}
      order by d.available_at, d.event_id
      limit 1
      for update of d skip locked`);
    const row = result.rows[0];
    return row ? { ...row, occurred_at: new Date(row.occurred_at) } : undefined;
  }

  /** Runs the module's handler as the module itself, in the claim's transaction. */
  private handle(row: ClaimedRow): Promise<void> {
    this.cls.set(CLS_ID, row.request_id ?? `evt-${row.event_id}`);
    enterEventDelivery(this.cls, row.subscriber, {
      id: row.event_id,
      type: row.type,
      producer: row.producer,
      aggregateId: row.aggregate_id,
      occurredAt: row.occurred_at,
      attempt: row.attempts + 1,
    });
    const handler = this.registry.handlerOf(row.subscriber, row.type);
    if (!handler) {
      throw new Undeliverable(
        'EVENT_TYPE_NOT_HANDLED',
        `${row.subscriber} has no handler of ${row.type}`,
      );
    }
    if (row.producer !== handler.subscription.event.producer) {
      throw new Undeliverable('UNEXPECTED_PRODUCER', `published by ${row.producer}`);
    }
    const payload = handler.subscription.event.schema.safeParse(row.payload);
    if (!payload.success) {
      throw new Undeliverable('EVENT_PAYLOAD_INVALID', payload.error.message);
    }
    const trace = row.traceparent
      ? propagation.extract(ROOT_CONTEXT, { traceparent: row.traceparent })
      : ROOT_CONTEXT;
    return context.with(trace, () => handler.invoke(payload.data));
  }

  /** Outside the rolled-back transaction: count the attempt, then retry later or give up. */
  private async recordFailure(row: ClaimedRow, error: unknown): Promise<DeliveryOutcome> {
    const failure =
      error instanceof Undeliverable
        ? { action: 'dead' as const, reason: error.reason, message: error.message }
        : classifyFailure(error);
    const attempts = row.attempts + 1;
    const dead = failure.action === 'dead' || attempts >= MAX_ATTEMPTS;
    const what = `${row.subscriber} ${row.type} ${row.event_id} (attempt ${attempts})`;
    if (dead) this.logger.error(`dead letter: ${what}: ${failure.reason}: ${failure.message}`);
    else this.logger.warn(`will retry ${what}: ${failure.reason}: ${failure.message}`);
    await this.db.tx
      .update(deliveries)
      .set({
        status: dead ? 'dead' : 'pending',
        attempts,
        availableAt: sql`now() + make_interval(secs => ${retryDelayMs(attempts) / 1000})`,
        lastError: `${failure.reason}: ${failure.message}`.slice(0, 1000),
      })
      .where(and(this.keyOf(row), eq(deliveries.status, 'pending')));
    return dead ? 'dead' : 'retry';
  }

  private keyOf(row: ClaimedRow) {
    return and(eq(deliveries.subscriber, row.subscriber), eq(deliveries.eventId, row.event_id));
  }

  /** Forgets delivered rows after DELIVERED_KEPT_DAYS and finished events after RETENTION_DAYS. */
  async purge(): Promise<void> {
    for (;;) {
      const done = await this.db.tx.execute<{ event_id: string }>(sql`
        delete from events.deliveries where ctid in (
          select ctid from events.deliveries
          where status = 'delivered'
            and delivered_at < now() - make_interval(days => ${DELIVERED_KEPT_DAYS})
          limit 1000)
        returning event_id`);
      if (done.rows.length < 1000) break;
    }
    for (;;) {
      const done = await this.db.tx.execute<{ id: string }>(sql`
        delete from events.events where id in (
          select e.id from events.events e
          where e.occurred_at < now() - make_interval(days => ${RETENTION_DAYS})
            and not exists (
              select 1 from events.deliveries d
              where d.event_id = e.id and d.status <> 'delivered')
          limit 1000)
        returning id`);
      if (done.rows.length < 1000) break;
    }
  }

  /** A provider with @OnEvent handlers that no `forFeature({ consumers })` lists would never run. */
  private assertEveryHandlerListed(): void {
    const listed = new Set<Type>(this.registry.subscriptions().map((s) => s.consumer));
    const scanner = new MetadataScanner();
    for (const wrapper of this.discovery.getProviders()) {
      const { metatype } = wrapper;
      if (typeof metatype !== 'function' || !metatype.prototype || listed.has(metatype as Type)) {
        continue;
      }
      const prototype = metatype.prototype as Record<string, unknown>;
      const handler = scanner
        .getAllMethodNames(prototype)
        .find((name) => handledEventOf(prototype[name]));
      if (handler) {
        throw new Error(
          `${metatype.name}.${handler} is an @OnEvent handler, but no EventsModule.forFeature lists ${metatype.name} in its consumers`,
        );
      }
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.round();
    }, delayMs);
    this.timer.unref();
  }

  private async round(): Promise<void> {
    let taken = 0;
    try {
      taken = await this.runOnce();
      this.failures = 0;
    } catch (error) {
      this.failures += 1;
      if (this.failures === 1 || this.failures % 20 === 0) {
        this.logger.warn(`event delivery failed (${this.failures} in a row): ${String(error)}`);
      }
    }
    const idle = Math.min(this.config.EVENTS_POLL_MS * 2 ** this.failures, 30_000);
    this.schedule(taken === this.config.EVENTS_BATCH ? 0 : idle);
  }
}
