import { DependencyUnavailableError } from '@gam/kernel';
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
import { and, eq, type SQL, sql } from 'drizzle-orm';
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

/**
 * What became of one claimed delivery. `lost`: its lease ended before the delivery could
 * start (another replica may hold it now).
 */
export type DeliveryOutcome = 'none' | 'delivered' | 'retry' | 'dead' | 'lost';

/** A delivery leased by this replica: its attempt is already counted and committed. */
interface Lease extends Record<string, unknown> {
  subscriber: string;
  event_id: string;
  type: string;
  /** The attempt this lease is (counted when it was leased). */
  attempts: number;
}

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

/** The handler did not settle within EVENTS_HANDLER_TIMEOUT_MS: retried like an outage. */
const handlerTimedOut = (ms: number) =>
  new DependencyUnavailableError(
    'HANDLER_TIMEOUT',
    `the handler did not finish within EVENTS_HANDLER_TIMEOUT_MS (${ms} ms)`,
  );

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
 * A delivery is first leased in a statement of its own that commits at once: the due row
 * of a (subscriber, type) pair this app handles is taken with FOR UPDATE SKIP LOCKED (so
 * replicas never take the same one), its attempt is counted and it is put out of reach
 * for the lease. Then one transaction locks the row again, calls the module's @OnEvent
 * handler in a fresh request context that acts as the module itself (currentService(),
 * currentEvent()), and marks the row delivered: the handler's writes and the mark commit
 * together, so an event takes effect once per subscriber. A handler gets
 * EVENTS_HANDLER_TIMEOUT_MS (enforced by Postgres' transaction_timeout too, from version
 * 17). A failed handler is retried with backoff (1 s doubling, at most 5 min) or, when it
 * cannot succeed, kept as a dead letter; so is a delivery that used up MAX_ATTEMPTS,
 * including attempts that never settled because the process died (the lease ran out).
 */
@Injectable()
export class EventDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('EventDispatcher');
  private timer: NodeJS.Timeout | undefined;
  private purgeTimer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;
  private failures = 0;
  /** Postgres 17+ can end a transaction that outlives the handler's deadline. */
  private transactionTimeout = false;

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
  async onApplicationBootstrap(): Promise<void> {
    this.assertEveryHandlerListed();
    this.registry.seal(this.moduleRef);
    if (this.registry.subscriptions().length > 0) {
      const version = await this.db.tx.execute<{ server_version_num: string }>(
        sql`show server_version_num`,
      );
      this.transactionTimeout = Number(version.rows[0]?.server_version_num ?? 0) >= 170_000;
    }
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
      this.logger.warn(
        'stopped with a delivery in flight; it rolls back and is due again after its lease',
      ),
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
   * Leases one due delivery (the oldest of the pairs this app handles, or exactly `only`,
   * handled or not) and processes it. Never throws for a handler failure; throws when the
   * database cannot be reached.
   */
  deliverNext(only?: {
    readonly subscriber: string;
    readonly eventId: string;
  }): Promise<DeliveryOutcome> {
    return this.cls.run({ ifNested: 'override' }, async () => {
      const lease = await this.lease(only);
      if (!lease) return 'none';
      if (lease.attempts > MAX_ATTEMPTS) return this.giveUp(lease);
      let timedOut: Error | undefined;
      try {
        return await this.host.withTransaction(async () => {
          const row = await this.relock(lease);
          if (!row) return 'lost' as const;
          if (this.transactionTimeout) {
            const timeout = `${this.config.EVENTS_HANDLER_TIMEOUT_MS}ms`;
            await this.db.tx.execute(
              sql`select set_config('transaction_timeout', ${timeout}, true)`,
            );
          }
          await this.withDeadline(this.handle(row), (error) => {
            timedOut = error;
          });
          await this.db.tx
            .update(deliveries)
            .set({ status: 'delivered', deliveredAt: sql`now()`, lastError: null })
            .where(this.leaseOf(lease));
          return 'delivered' as const;
        });
      } catch (error) {
        // After a deadline the rollback itself may fail (Postgres ended the session):
        // the deadline is what happened.
        return this.recordFailure(lease, timedOut ?? error);
      }
    });
  }

  /** Counts the next attempt of a due delivery and puts it out of reach, in one committed statement. */
  private async lease(
    only: { readonly subscriber: string; readonly eventId: string } | undefined,
  ): Promise<Lease | undefined> {
    let which: SQL;
    if (only) {
      which = sql`subscriber = ${only.subscriber} and event_id = ${only.eventId}`;
    } else {
      // Only pairs this app handles: during a rolling deploy, a replica of the previous
      // version leaves the deliveries of a subscription it does not know yet to the new one.
      const pairs = this.registry.subscriptions().map((s) => sql`(${s.module}, ${s.event.type})`);
      if (pairs.length === 0) return undefined;
      which = sql`(subscriber, type) in (${sql.join(pairs, sql`, `)})`;
    }
    const leaseSeconds = (this.config.EVENTS_HANDLER_TIMEOUT_MS * 2 + 5_000) / 1000;
    const result = await this.db.tx.execute<Lease>(sql`
      update events.deliveries d
      set attempts = d.attempts + 1,
          available_at = now() + make_interval(secs => ${leaseSeconds})
      from (
        select subscriber, event_id from events.deliveries
        where status = 'pending' and available_at <= now() and ${which}
        order by available_at, event_id
        limit 1
        for update skip locked
      ) due
      where d.subscriber = due.subscriber and d.event_id = due.event_id
      returning d.subscriber, d.event_id, d.type, d.attempts`);
    return result.rows[0];
  }

  /** Locks a leased delivery for its transaction; undefined when the lease was lost. */
  private async relock(lease: Lease): Promise<ClaimedRow | undefined> {
    const result = await this.db.tx.execute<ClaimedRow>(sql`
      select d.subscriber, d.event_id, d.attempts, e.type, e.producer, e.aggregate_id,
             e.occurred_at, e.payload, e.request_id, e.traceparent
      from events.deliveries d join events.events e on e.id = d.event_id
      where d.subscriber = ${lease.subscriber} and d.event_id = ${lease.event_id}
        and d.status = 'pending' and d.attempts = ${lease.attempts}
      for update of d skip locked`);
    const row = result.rows[0];
    return row ? { ...row, occurred_at: new Date(row.occurred_at) } : undefined;
  }

  /** Rejects when `work` outlives the handler's deadline; `work` itself may never settle. */
  private withDeadline(work: Promise<void>, onTimeout: (error: Error) => void): Promise<void> {
    // Just past transaction_timeout, so Postgres ends a busy transaction first.
    const ms = this.config.EVENTS_HANDLER_TIMEOUT_MS + 1_000;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = handlerTimedOut(this.config.EVENTS_HANDLER_TIMEOUT_MS);
        onTimeout(error);
        reject(error);
      }, ms);
    });
    // A handler that settles after its deadline must not become an unhandled rejection.
    work.catch(() => undefined);
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
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
      attempt: row.attempts,
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

  /** Outside the rolled-back transaction: retry later (after a backoff) or give up. */
  private async recordFailure(lease: Lease, error: unknown): Promise<DeliveryOutcome> {
    const failure =
      error instanceof Undeliverable
        ? { action: 'dead' as const, reason: error.reason, message: error.message }
        : classifyFailure(error);
    const dead = failure.action === 'dead' || lease.attempts >= MAX_ATTEMPTS;
    const what = `${lease.subscriber} ${lease.type} ${lease.event_id} (attempt ${lease.attempts})`;
    if (dead) this.logger.error(`dead letter: ${what}: ${failure.reason}: ${failure.message}`);
    else this.logger.warn(`will retry ${what}: ${failure.reason}: ${failure.message}`);
    await this.db.tx
      .update(deliveries)
      .set({
        status: dead ? 'dead' : 'pending',
        availableAt: sql`now() + make_interval(secs => ${retryDelayMs(lease.attempts) / 1000})`,
        lastError: `${failure.reason}: ${failure.message}`.slice(0, 1000),
      })
      .where(this.leaseOf(lease));
    return dead ? 'dead' : 'retry';
  }

  /** A delivery whose earlier attempts never settled (the process died) and that has none left. */
  private async giveUp(lease: Lease): Promise<DeliveryOutcome> {
    const message = `${MAX_ATTEMPTS} attempts did not settle (the process stopped during them, or their lease ran out)`;
    this.logger.error(
      `dead letter: ${lease.subscriber} ${lease.type} ${lease.event_id}: ATTEMPTS_EXHAUSTED: ${message}`,
    );
    await this.db.tx
      .update(deliveries)
      .set({ status: 'dead', lastError: `ATTEMPTS_EXHAUSTED: ${message}` })
      .where(this.leaseOf(lease));
    return 'dead';
  }

  /** The leased row, as long as no other lease replaced this one. */
  private leaseOf(lease: Lease) {
    return and(
      eq(deliveries.subscriber, lease.subscriber),
      eq(deliveries.eventId, lease.event_id),
      eq(deliveries.status, 'pending'),
      eq(deliveries.attempts, lease.attempts),
    );
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
