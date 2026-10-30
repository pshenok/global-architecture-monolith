import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DependencyUnavailableError, IdGenerator, UnitOfWork, ValidationError } from '@gam/kernel';
import { Injectable, Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { currentEvent, currentService } from '../src/auth/actor-context.ts';
import { DbContext } from '../src/database/db-context.ts';
import { PLATFORM_MIGRATIONS } from '../src/database/platform-migrations.ts';
import { type Database, DRIZZLE } from '../src/database/tokens.ts';
import { EventsAdmin } from '../src/events/admin.ts';
import { EventDispatcher, RETENTION_DAYS } from '../src/events/dispatcher.ts';
import { defineEvent, type EventPayload } from '../src/events/event-type.ts';
import { EventsModule } from '../src/events/events.module.ts';
import { OnEvent } from '../src/events/on-event.ts';
import { Outbox } from '../src/events/outbox.ts';
import { eventCatalog, eventFeatureOf } from '../src/events/registry.ts';
import { MAX_ATTEMPTS } from '../src/events/retry.ts';
import { CrossModuleCallInTransactionError, ModuleApi } from '../src/platform/module-api.ts';
import { deliverEvent, flushEvents, recordedEvents } from '../src/testing/events.ts';
import { createTestApp, type TestApp } from '../src/testing/test-app.ts';
import { createTestDatabase, type TestDatabase } from '../src/testing/test-database.ts';

const WIDGET_CREATED = defineEvent(
  'widgets.v1.WidgetCreatedEvent',
  z.object({ widgetId: z.uuid(), name: z.string().min(1) }),
);
const WIDGET_DELETED = defineEvent(
  'widgets.v1.WidgetDeletedEvent',
  z.object({ widgetId: z.uuid() }),
);
const GADGET_MADE = defineEvent('gadgets.v1.GadgetMadeEvent', z.object({ gadgetId: z.uuid() }));
const DATED = defineEvent('widgets.v1.WidgetDatedEvent', z.object({ at: z.date() }));

/** The public API of the widgets module, for the cross-module guard. */
@ModuleApi()
@Injectable()
class WidgetsApi {
  async count(): Promise<number> {
    return 1;
  }
}

@Injectable()
class WidgetService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: Outbox,
    private readonly ids: IdGenerator,
    private readonly db: DbContext,
  ) {}

  /** Publishes WidgetCreatedEvent with a change of its own, optionally failing after it. */
  create(name: string, options: { fail?: boolean } = {}): Promise<string> {
    const id = this.ids.newId();
    return this.unitOfWork.run(async () => {
      await this.db.tx.execute(sql`insert into widgets.widgets (id, name) values (${id}, ${name})`);
      await this.outbox.add(WIDGET_CREATED, id, { widgetId: id, name });
      if (options.fail) throw new Error('rolled back');
      return id;
    });
  }

  addOutsideTransaction(): Promise<void> {
    const id = this.ids.newId();
    return this.outbox.add(WIDGET_CREATED, id, { widgetId: id, name: 'x' });
  }

  add(event: Parameters<Outbox['add']>[0], payload: object): Promise<void> {
    return this.unitOfWork.run(() => this.outbox.add(event, this.ids.newId(), payload as never));
  }
}

@Module({
  imports: [EventsModule.forFeature({ module: 'widgets', publish: true })],
  providers: [WidgetService, WidgetsApi],
  exports: [WidgetService, WidgetsApi],
})
class WidgetsModule {}

type Behaviour = 'ok' | 'transient' | 'invalid' | 'bug' | 'cross-module' | 'wait' | 'hang';

/** Records what it saw in its own table, then behaves as told. */
@Injectable()
class GadgetsConsumer {
  behaviour: Behaviour = 'ok';
  release: (() => void) | undefined;
  started: Promise<void> | undefined;

  constructor(
    private readonly db: DbContext,
    private readonly widgets: WidgetsApi,
  ) {}

  @OnEvent(WIDGET_CREATED)
  async widgetCreated(event: EventPayload<typeof WIDGET_CREATED>): Promise<void> {
    const info = currentEvent();
    await this.db.tx.execute(sql`
      insert into gadgets.seen (event_id, widget_id, actor, attempt)
      values (${info?.id}, ${event.widgetId}, ${currentService().name}, ${info?.attempt})`);
    switch (this.behaviour) {
      case 'transient':
        throw new DependencyUnavailableError('PROBE_DOWN', 'try again later');
      case 'invalid':
        throw new ValidationError('this widget can never be handled');
      case 'bug':
        throw new Error('a bug');
      case 'cross-module':
        await this.widgets.count();
        return;
      case 'wait':
        await new Promise<void>((resolve) => {
          this.release = resolve;
        });
        return;
      case 'hang':
        await new Promise<void>(() => undefined);
        return;
      case 'ok':
        return;
    }
  }
}

@Module({
  imports: [
    WidgetsModule,
    EventsModule.forFeature({ module: 'gadgets', consumers: [GadgetsConsumer] }),
  ],
  providers: [GadgetsConsumer],
})
class GadgetsModule {}

@Injectable()
class GizmosConsumer {
  readonly seen: string[] = [];

  @OnEvent(WIDGET_CREATED)
  async widgetCreated(event: EventPayload<typeof WIDGET_CREATED>): Promise<void> {
    this.seen.push(event.widgetId);
  }
}

@Module({
  imports: [EventsModule.forFeature({ module: 'gizmos', consumers: [GizmosConsumer] })],
  providers: [GizmosConsumer],
})
class GizmosModule {}

function testSchema(): { name: string; folder: string } {
  const folder = mkdtempSync(join(tmpdir(), 'gam-events-'));
  const migration = join(folder, '20260101000000_init');
  mkdirSync(migration);
  writeFileSync(
    join(migration, 'migration.sql'),
    `create schema widgets;
     create table widgets.widgets (id uuid primary key, name text not null);
     create schema gadgets;
     create table gadgets.seen (event_id uuid, widget_id uuid, actor text, attempt int);`,
  );
  writeFileSync(join(migration, 'snapshot.json'), '{}');
  return { name: 'probes', folder };
}

describe('events (outbox, dispatcher, admin)', () => {
  const probes = testSchema();
  let db: TestDatabase;
  let api: TestApp;
  let widgets: WidgetService;
  let gadgets: GadgetsConsumer;
  let gizmos: GizmosConsumer;
  let dispatcher: EventDispatcher;
  let admin: EventsAdmin;

  beforeAll(async () => {
    db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS, probes] });
    api = await createTestApp({
      database: db,
      modules: [GadgetsModule, GizmosModule],
      env: { EVENTS_HANDLER_TIMEOUT_MS: '1500' },
    });
    widgets = api.get(WidgetService);
    gadgets = api.get(GadgetsConsumer);
    gizmos = api.get(GizmosConsumer);
    dispatcher = api.get(EventDispatcher);
    admin = new EventsAdmin(api.get<Database>(DRIZZLE));
  });

  afterAll(async () => {
    await api?.close();
    await db?.dispose();
    rmSync(probes.folder, { recursive: true, force: true });
  });

  beforeEach(async () => {
    gadgets.behaviour = 'ok';
    gadgets.release = undefined;
    gizmos.seen.length = 0;
    await db.truncate('events.events', 'widgets.widgets', 'gadgets.seen');
  });

  const seen = async () =>
    (await db.pool.query('select widget_id, actor, attempt from gadgets.seen order by attempt'))
      .rows;
  const delivery = async (subscriber: string) =>
    (
      await db.pool.query(
        `select status, attempts, last_error, available_at > now() as waiting
         from events.deliveries where subscriber = $1`,
        [subscriber],
      )
    ).rows[0];

  describe('Outbox', () => {
    it('records the event with one delivery per subscribing module, in the change transaction', async () => {
      const id = await widgets.create('anvil');
      const [event, ...rest] = await recordedEvents(api);
      expect(rest).toEqual([]);
      expect(event).toMatchObject({
        type: 'widgets.v1.WidgetCreatedEvent',
        producer: 'widgets',
        aggregateId: id,
        payload: { widgetId: id, name: 'anvil' },
        deliveries: [
          { subscriber: 'gadgets', status: 'pending', attempts: 0 },
          { subscriber: 'gizmos', status: 'pending', attempts: 0 },
        ],
      });
    });

    it('records nothing when the change rolls back', async () => {
      await expect(widgets.create('anvil', { fail: true })).rejects.toThrow('rolled back');
      expect(await recordedEvents(api)).toEqual([]);
    });

    it('refuses outside a transaction, for another module, and for a bad payload', async () => {
      await expect(widgets.addOutsideTransaction()).rejects.toThrow(/outside UnitOfWork.run/);
      await expect(widgets.add(GADGET_MADE, { gadgetId: crypto.randomUUID() })).rejects.toThrow(
        /widgets cannot publish gadgets.v1.GadgetMadeEvent: gadgets owns it/,
      );
      await expect(widgets.add(WIDGET_CREATED, { widgetId: 'nope', name: '' })).rejects.toThrow(
        /invalid payload/,
      );
      await expect(widgets.add(DATED, { at: new Date() })).rejects.toThrow(/does not survive JSON/);
      await expect(
        widgets.add(WIDGET_CREATED, { widgetId: crypto.randomUUID(), name: 'x'.repeat(70_000) }),
      ).rejects.toThrow(/over 64 KiB/);
      expect(await recordedEvents(api)).toEqual([]);
    });

    it('records an event nobody subscribes to without deliveries', async () => {
      await widgets.add(WIDGET_DELETED, { widgetId: crypto.randomUUID() });
      const [event] = await recordedEvents(api);
      expect(event?.deliveries).toEqual([]);
    });
  });

  describe('EventDispatcher', () => {
    it('delivers to each subscriber as that module, once, and marks it delivered', async () => {
      const id = await widgets.create('anvil');
      expect(await flushEvents(api)).toBe(2);
      expect(await seen()).toEqual([{ widget_id: id, actor: 'gadgets', attempt: 1 }]);
      expect(gizmos.seen).toEqual([id]);
      const [event] = await recordedEvents(api);
      expect(event?.deliveries.map((d) => d.status)).toEqual(['delivered', 'delivered']);
      expect(await flushEvents(api)).toBe(0);
      expect(gizmos.seen).toEqual([id]);
    });

    it('retries a transient failure later, rolling the handler back each time', async () => {
      await widgets.create('anvil');
      gadgets.behaviour = 'transient';
      await flushEvents(api);
      expect(await seen()).toEqual([]);
      expect(await delivery('gadgets')).toMatchObject({
        status: 'pending',
        attempts: 1,
        waiting: true,
        last_error: 'PROBE_DOWN: try again later',
      });
      gadgets.behaviour = 'ok';
      await db.pool.query('update events.deliveries set available_at = now()');
      await flushEvents(api);
      expect(await seen()).toEqual([expect.objectContaining({ attempt: 2 })]);
      expect(await delivery('gadgets')).toMatchObject({ status: 'delivered', attempts: 2 });
    });

    it('dead-letters a failure that cannot go away, and gives up after MAX_ATTEMPTS', async () => {
      await widgets.create('anvil');
      gadgets.behaviour = 'invalid';
      await flushEvents(api);
      expect(await delivery('gadgets')).toMatchObject({
        status: 'dead',
        attempts: 1,
        last_error: 'VALIDATION_FAILED: this widget can never be handled',
      });
      await db.truncate('events.events');
      await widgets.create('anvil');
      gadgets.behaviour = 'bug';
      await db.pool.query(
        `update events.deliveries set attempts = ${MAX_ATTEMPTS - 1} where subscriber = 'gadgets'`,
      );
      await flushEvents(api);
      expect(await delivery('gadgets')).toMatchObject({
        status: 'dead',
        attempts: MAX_ATTEMPTS,
        last_error: 'HANDLER_FAILED: a bug',
      });
      expect(await seen()).toEqual([]);
    });

    it('dead-letters a handler that calls another module inside its transaction', async () => {
      await widgets.create('anvil');
      gadgets.behaviour = 'cross-module';
      await flushEvents(api);
      expect(await delivery('gadgets')).toMatchObject({
        status: 'dead',
        last_error: expect.stringMatching(/^CROSS_MODULE_CALL_IN_TRANSACTION: WidgetsApi.count/),
      });
      await expect(api.get(WidgetsApi).count()).resolves.toBe(1);
    });

    it('dead-letters a delivery without a handler, and a payload that no longer validates', async () => {
      const unhandled = await deliverEvent(api, {
        subscriber: 'gadgets',
        event: WIDGET_DELETED,
        aggregateId: 'w-1',
        payload: { widgetId: crypto.randomUUID() },
      });
      expect(unhandled.outcome).toBe('dead');
      const invalid = await deliverEvent(api, {
        subscriber: 'gadgets',
        event: WIDGET_CREATED,
        aggregateId: 'w-2',
        payload: { widgetId: 'not-a-uuid', name: 'x' },
      });
      expect(invalid.outcome).toBe('dead');
      const errors = (
        await db.pool.query('select last_error from events.deliveries order by last_error')
      ).rows.map((row) => row.last_error.split(':')[0]);
      expect(errors).toEqual(['EVENT_PAYLOAD_INVALID', 'EVENT_TYPE_NOT_HANDLED']);
    });

    it('counts the attempt before the handler runs, so one cut short by a crash still counts', async () => {
      await widgets.create('anvil');
      gadgets.behaviour = 'wait';
      const [event] = await recordedEvents(api);
      const running = dispatcher.deliverNext({ subscriber: 'gadgets', eventId: event?.id ?? '' });
      await expect.poll(() => gadgets.release).toBeDefined();
      // Committed by the lease, before the handler: a process that dies here used it up.
      expect(await delivery('gadgets')).toMatchObject({
        status: 'pending',
        attempts: 1,
        waiting: true,
      });
      gadgets.release?.();
      expect(await running).toBe('delivered');
      expect(await delivery('gadgets')).toMatchObject({ status: 'delivered', attempts: 1 });
    });

    it('gives up on a delivery whose attempts never settled, without running it again', async () => {
      await widgets.create('anvil');
      await db.pool.query(
        `update events.deliveries set attempts = ${MAX_ATTEMPTS} where subscriber = 'gadgets'`,
      );
      await flushEvents(api);
      expect(await delivery('gadgets')).toMatchObject({
        status: 'dead',
        last_error: expect.stringMatching(/^ATTEMPTS_EXHAUSTED: /),
      });
      expect(await seen()).toEqual([]);
    });

    it('retries a handler that outlives its deadline, with nothing of it committed', async () => {
      await widgets.create('anvil');
      gadgets.behaviour = 'hang';
      const [event] = await recordedEvents(api);
      const outcome = await dispatcher.deliverNext({
        subscriber: 'gadgets',
        eventId: event?.id ?? '',
      });
      expect(outcome).toBe('retry');
      expect(await delivery('gadgets')).toMatchObject({
        status: 'pending',
        attempts: 1,
        waiting: true,
        last_error: expect.stringMatching(/^HANDLER_TIMEOUT: /),
      });
      expect(await seen()).toEqual([]);
      // The dispatcher is not stuck behind it.
      expect(await flushEvents(api)).toBe(1);
      expect(gizmos.seen).toHaveLength(1);
    });

    it('leaves deliveries of pairs this app does not handle to the replicas that do', async () => {
      await widgets.create('anvil');
      const [event] = await recordedEvents(api);
      await db.pool.query(
        `insert into events.deliveries (subscriber, event_id, type) values ('newer-module', $1, $2)`,
        [event?.id, WIDGET_CREATED.type],
      );
      await flushEvents(api);
      expect(await delivery('newer-module')).toMatchObject({ status: 'pending', attempts: 0 });
      expect(await delivery('gadgets')).toMatchObject({ status: 'delivered' });
    });

    it('never gives one delivery to two workers (SKIP LOCKED)', async () => {
      await widgets.create('anvil');
      gadgets.behaviour = 'wait';
      const first = dispatcher.deliverNext({
        subscriber: 'gadgets',
        eventId: (await recordedEvents(api))[0]?.id ?? '',
      });
      await expect.poll(() => gadgets.release).toBeDefined();
      // The gadgets row is locked by the first worker: a second one sees only gizmos'.
      expect(await dispatcher.deliverNext()).toBe('delivered');
      expect(await dispatcher.deliverNext()).toBe('none');
      gadgets.release?.();
      expect(await first).toBe('delivered');
      expect((await seen()).length).toBe(1);
    });
  });

  describe('EventsAdmin', () => {
    it('reports, redrives, drops and replays per (subscriber, type)', async () => {
      await widgets.create('one');
      await widgets.create('two');
      gadgets.behaviour = 'invalid';
      await flushEvents(api);
      expect(await admin.status()).toEqual([
        expect.objectContaining({
          subscriber: 'gadgets',
          type: WIDGET_CREATED.type,
          pending: 0,
          dead: 2,
          delivered: 0,
          lastError: 'VALIDATION_FAILED: this widget can never be handled',
        }),
        expect.objectContaining({ subscriber: 'gizmos', dead: 0, delivered: 2 }),
      ]);

      gadgets.behaviour = 'ok';
      expect(await admin.redrive('gadgets', WIDGET_CREATED.type)).toBe(2);
      expect(await admin.redrive('gadgets', WIDGET_CREATED.type)).toBe(0);
      await flushEvents(api);
      expect((await seen()).length).toBe(2);

      expect(await admin.replay('gizmos', WIDGET_CREATED.type, new Date(Date.now() - 60_000))).toBe(
        2,
      );
      await flushEvents(api);
      expect(gizmos.seen).toHaveLength(4);
      expect(await admin.replay('gizmos', WIDGET_CREATED.type, new Date(Date.now() + 60_000))).toBe(
        0,
      );

      gadgets.behaviour = 'invalid';
      await admin.replay('gadgets', WIDGET_CREATED.type, new Date(0));
      await flushEvents(api);
      expect(await admin.drop('gadgets', WIDGET_CREATED.type)).toBe(2);
      expect(await admin.status()).toEqual([
        expect.objectContaining({ subscriber: 'gizmos', dead: 0 }),
      ]);

      // A retired pair: pending deliveries no replica leases go only when asked for.
      await admin.replay('gizmos', WIDGET_CREATED.type, new Date(0));
      expect(await admin.drop('gizmos', WIDGET_CREATED.type)).toBe(0);
      expect(await admin.drop('gizmos', WIDGET_CREATED.type, { retired: true })).toBe(2);
      expect(await admin.status()).toEqual([]);
    });

    it('purges finished events after the retention window, never unfinished ones', async () => {
      await widgets.create('old-done');
      await widgets.create('old-dead');
      await flushEvents(api);
      const [done, dead] = await recordedEvents(api);
      await db.pool.query(`update events.deliveries set status = 'dead' where event_id = $1`, [
        dead?.id,
      ]);
      await db.pool.query(
        `update events.events set occurred_at = now() - make_interval(days => ${RETENTION_DAYS + 1})`,
      );
      await db.pool.query(`update events.deliveries set delivered_at = now() - interval '8 days'`);
      await dispatcher.purge();
      const left = await recordedEvents(api);
      expect(left.map((event) => event.id)).toEqual([dead?.id]);
      expect(done).toBeDefined();
    });
  });
});

describe('event features', () => {
  @Injectable()
  class Twice {
    @OnEvent(WIDGET_CREATED)
    async a(_event: EventPayload<typeof WIDGET_CREATED>): Promise<void> {}

    @OnEvent(WIDGET_CREATED)
    async b(_event: EventPayload<typeof WIDGET_CREATED>): Promise<void> {}
  }

  @Injectable()
  class Nothing {}

  it('refuse two handlers of a type, a consumer without handlers, and empty features', () => {
    expect(() => eventFeatureOf({ module: 'twice', consumers: [Twice] })).toThrow(
      /two handlers of widgets.v1.WidgetCreatedEvent/,
    );
    expect(() => eventFeatureOf({ module: 'nothing', consumers: [Nothing] })).toThrow(
      /no @OnEvent handler/,
    );
    expect(() => eventFeatureOf({ module: 'empty' })).toThrow(/needs publish, consumers/);
    expect(() => eventFeatureOf({ module: 'Bad_Name', publish: true })).toThrow(/kebab-case/);
  });

  it('name the producer by the type, and refuse other names', () => {
    expect(WIDGET_CREATED.producer).toBe('widgets');
    expect(() => defineEvent('WidgetCreated', z.object({}))).toThrow(/<module>.v<N>/);
    expect(() => defineEvent('widgets.v1.widgetCreated', z.object({}))).toThrow();
  });

  it('are in the catalog the operator CLI reads', () => {
    expect(eventCatalog()).toEqual(
      expect.arrayContaining([
        { subscriber: 'gadgets', type: WIDGET_CREATED.type },
        { subscriber: 'gizmos', type: WIDGET_CREATED.type },
      ]),
    );
  });

  it('fail boot when a provider has handlers no feature lists', async () => {
    @Injectable()
    class Stray {
      @OnEvent(WIDGET_DELETED)
      async deleted(_event: EventPayload<typeof WIDGET_DELETED>): Promise<void> {}
    }
    @Module({ providers: [Stray] })
    class StrayModule {}
    const db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS] });
    try {
      await expect(createTestApp({ database: db, modules: [StrayModule] })).rejects.toThrow(
        /Stray.deleted is an @OnEvent handler, but no EventsModule.forFeature lists Stray/,
      );
    } finally {
      await db.dispose();
    }
  });
});

describe('ModuleApi', () => {
  class BaseApi {
    async inherited(): Promise<string> {
      return 'inherited';
    }
  }

  @ModuleApi()
  @Injectable()
  class ShapesApi extends BaseApi {
    async own(): Promise<string> {
      return 'own';
    }

    get state(): string {
      return 'state';
    }

    async [Symbol.for('probe')](): Promise<string> {
      return 'symbol';
    }
  }

  @Module({ providers: [ShapesApi], exports: [ShapesApi] })
  class ShapesModule {}

  it('refuses a call inside the caller transaction, and only there, whatever the shape', async () => {
    const db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS] });
    const api = await createTestApp({ database: db, modules: [WidgetsModule, ShapesModule] });
    try {
      const widgetsApi = api.get(WidgetsApi);
      await expect(widgetsApi.count()).resolves.toBe(1);
      const unitOfWork = api.get(UnitOfWork);
      await expect(unitOfWork.run(() => widgetsApi.count())).rejects.toBeInstanceOf(
        CrossModuleCallInTransactionError,
      );
      expect(WidgetsApi.prototype.count.name).toBe('count');
      const shapes = api.get(ShapesApi);
      const symbol = Symbol.for('probe') as unknown as 'own';
      await expect(shapes.inherited()).resolves.toBe('inherited');
      expect(shapes.state).toBe('state');
      await expect(shapes[symbol]()).resolves.toBe('symbol');
      for (const call of [() => shapes.own(), () => shapes.inherited(), () => shapes[symbol]()]) {
        await expect(unitOfWork.run(call)).rejects.toBeInstanceOf(
          CrossModuleCallInTransactionError,
        );
      }
      await expect(unitOfWork.run(async () => shapes.state)).rejects.toBeInstanceOf(
        CrossModuleCallInTransactionError,
      );
      // The base class itself is left alone.
      await expect(unitOfWork.run(() => new BaseApi().inherited())).resolves.toBe('inherited');
    } finally {
      await api.close();
      await db.dispose();
    }
  });

  it('fails boot for a method written as a field, which the guard cannot wrap', async () => {
    @ModuleApi()
    @Injectable()
    class FieldApi {
      find = async (): Promise<number> => 1;
    }
    @Module({ providers: [FieldApi] })
    class FieldModule {}
    const db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS] });
    try {
      await expect(createTestApp({ database: db, modules: [FieldModule] })).rejects.toThrow(
        /methods written as fields.*FieldApi\.find/,
      );
    } finally {
      await db.dispose();
    }
  });
});
