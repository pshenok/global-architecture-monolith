---

name: gam-module-communication
description: How global-architecture-monolith modules talk to each other - calling another module through a port in your own terms and an adapter in infrastructure/ that calls its @ModuleApi class, importing its Nest module and declaring the package dependency, the acyclic module graph (check-boundaries), never calling inside a transaction (CrossModuleCallInTransactionError), translating the other module's errors, snapshots for authorization, and asynchronous events in process (domain-named port + Outbox adapter + EventsModule.forFeature({ module, publish }) to publish, @OnEvent consumers listed in forFeature({ consumers }) to handle, delivery in one transaction with retries and dead letters, events:status/redrive/replay/drop). Use it whenever a module needs data or an action from another, must react to something that happened in another (a delete, a change), when adding a dependency, a producer or a consumer, or when debugging CrossModuleCallInTransactionError, a module cycle, event lag or dead letters.
---

# Calling another module

Modules never share tables or transactions. If houses needs to know whether a user exists,
it asks the users module through `UsersApi`, in process. Every such dependency is visible
in four places: the caller's `package.json`, its Nest module's `imports`, a port in its
application layer with an adapter in its infrastructure, and the callee's `@ModuleApi`
class that answers (`gam-module-api`).

## Steps (bookings -> houses is the reference)

1. **Port** in `src/application/ports/house-catalog.ts`, phrased in your domain's terms:

   ```ts
   /** What the bookings module needs to know about houses. */
   export abstract class HouseCatalog {
     /** Current booking terms of a house, or null when it does not exist. */
     abstract findTerms(houseId: string): Promise<HouseTerms | null>;
   }
   ```

   Phrase the port by what the callee lets you ask. `UsersApi.stillExists(actor)` answers
   as the acting user, so `UserDirectory.stillExists(actor: UserActor)` takes the actor,
   not any id. To learn about other users you would need a new `@ModuleApi` method,
   reviewed by the users module's owners, never a looser reading of an existing one.
2. **Dependency**: `"@gam/houses": "workspace:*"` in `modules/bookings/package.json`, then
   `pnpm install`. `check-boundaries` refuses an import of a module that `package.json`
   does not declare, and any import of it other than its root (`@gam/houses`).
3. **Nest module**: import the callee's Nest module so its exported `@ModuleApi` provider
   is injectable: `imports: [UsersModule, HousesModule, EventsModule.forFeature(...)]` in
   `bookings.module.ts`.
4. **Adapter** (anti-corruption layer) in `src/infrastructure/` (bookings keeps them in
   `infrastructure/modules/`, houses in `infrastructure/users/`):

   ```ts
   @Injectable()
   export class HousesApiCatalog extends HouseCatalog {
     constructor(private readonly houses: HousesApi) { super(); } // value import
     async findTerms(houseId: string): Promise<HouseTerms | null> {
       const house = await this.houses.findHouse(houseId);
       if (!house) return null;
       return { maxGuests: house.maxGuests, nightlyPrice: { ...house.nightlyPrice },
                ownerId: house.ownerId };
     }
   }
   ```

   The adapter maps the provider's summary (`HouseSummary`) to your terms (`HouseTerms`)
   and is the only file of your module that names the other module's API.
5. **Bind** in `<module>.module.ts`: `{ provide: HouseCatalog, useClass: HousesApiCatalog }`.
6. **Test**: use-case tests with a fake of the port (`FakeHouseCatalog` in `test/fakes.ts`);
   HTTP tests override the port (`overrides: new Map([[HouseCatalog, new
   FakeHouseCatalog()]])`) or the callee's API itself (houses: `overrides: new
   Map([[UsersApi, users]])`), see `gam-testing`.

## The rules

- **Dependencies form a DAG** (users <- houses <- bookings). `check-boundaries` fails
  `pnpm lint` on a cycle of module dependencies (`module dependencies form a cycle: ...`).
  If A must react to something in B and B already depends on A, that reaction is an event.
- **Never call another module inside a transaction.** Every `@ModuleApi` method rejects
  with `CrossModuleCallInTransactionError` ("... was called inside a transaction: modules
  never share one (ADR-0002); call it before UnitOfWork.run, or react to an event") when a
  transaction is open, before running anything. It is a plain `Error`, so a request gets
  500 and an event handler dead-letters (`CROSS_MODULE_CALL_IN_TRANSACTION`). Read from
  other modules first, then open your one local transaction.
- **Parallelize independent calls** (`Promise.all`), as `BookingService.create` does for
  the guest and the house.
- **Errors arrive as `DomainError`s, in process.** Translate in the adapter or the callee's
  API what your use case expects (a missing house is `null`, and the use case raises its
  own `PreconditionFailedError` `BOOKING_HOUSE_NOT_FOUND`); let anything else surface.
  Never forward another module's reason as if it were yours: your module's errors are
  part of its contract.
- **Store references, not copies**: keep `owner_id`, not the owner's name. If you must
  copy (a price at booking time), copy it deliberately and name it as a snapshot
  (`total_price_minor` is frozen at booking time).
- **Snapshot immutable facts that authorization needs.** A booking stores the house owner
  as `host_id` when it is created (houses never change owner), so "may the host see this
  booking" needs no call on every read. If such a fact becomes mutable, the owner module
  publishes an event that updates the snapshots (ADR-0002).
- **Know what a check is worth.** "The user exists" is true at check time only. Deleting a
  user or a house cleans up what references it through events, but a house or booking
  created between the check and the cleanup can stay orphaned (known gap).

## Asynchronous events (ADR-0005)

Use an event, not a call, when the producer should not know its consumers, the reaction
can happen a little later, or a call would close a cycle (users must not call houses,
which depends on users). A consumer imports the producer's event type, so it depends on
the producer: events flow from a module to the modules that depend on it. Delivery is in
process, from the same database, **effectively once per subscriber and unordered**.

### Producer (houses -> `houses.v1.HouseDeletedEvent` is the reference)

1. **Event type** `HOUSE_DELETED` in `src/contracts/house-events.ts`, exported from
   `src/index.ts` (`gam-module-api`).
2. **Port** in the application layer, in domain terms:
   `abstract class HouseEvents { abstract deleted(house: House): Promise<void> }`.
3. **Adapter** in `src/infrastructure/events/outbox-house-events.ts`:

   ```ts
   @Injectable()
   export class OutboxHouseEvents extends HouseEvents {
     constructor(private readonly outbox: Outbox) { super(); }
     deleted(house: House): Promise<void> {
       return this.outbox.add(HOUSE_DELETED, house.id, { houseId: house.id, ownerId: house.ownerId });
     }
   }
   ```

4. **Wiring**: `EventsModule.forFeature({ module: 'houses', publish: true })` in the
   module's `imports` (it provides this module's own `Outbox`), and
   `{ provide: HouseEvents, useClass: OutboxHouseEvents }`. No tables to add: the
   `events` schema is the platform's (`gam-database`).
5. **Call the port inside the change's `UnitOfWork.run`, after the change**
   (`HouseService.delete`).

`Outbox.add(event, aggregateId, payload)` inserts the event into `events.events` and one
row per subscribing module into `events.deliveries`, in the current transaction. It throws
(rolling the change back) outside `UnitOfWork.run`, for another module's event type, for an
aggregate id outside 1..128 characters, and for a payload that fails its schema, does not
survive JSON or is over 64 KiB. The event exists if and only if the change committed.
Subscribers are those of the running app at publish time.

### Consumer (bookings reacting to `HouseDeletedEvent`)

```ts
// modules/bookings/src/transport/events/house-events.consumer.ts
@Injectable()
export class HouseEventsConsumer {
  constructor(private readonly bookings: BookingService) {}

  @OnEvent(HOUSE_DELETED) // imported from '@gam/houses'
  async houseDeleted(event: EventPayload<typeof HOUSE_DELETED>): Promise<void> {
    await this.bookings.cancelOpenStaysOfHouse(currentService(), event.houseId);
  }
}
```

- **Wiring**: the consumer is in the module's `providers` and in
  `EventsModule.forFeature({ module: 'bookings', consumers: [HouseEventsConsumer,
  UserEventsConsumer] })`. Boot fails on a provider with `@OnEvent` handlers that no
  feature lists, a listed consumer that is not a provider, a consumer without handlers,
  two handlers of one type in a module, and a feature with neither `publish` nor
  `consumers`.
- **One handler per type per module, one use case per handler**, passing `currentService()`
  (a `ServiceActor` named after the subscribing module). Never take an actor parameter
  (check-access refuses an actor in any parameter of a decorated method). `currentEvent()`
  gives `id`, `type`, `producer`, `aggregateId`, `occurredAt` and `attempt`.
- **The handler and the acknowledgement commit together**: the dispatcher claims the
  delivery, runs the handler and marks it delivered in one transaction, so its effect
  happens once per subscriber and a failure leaves nothing behind. No `processed_events`
  table is needed.
- **No calls to other modules** in a handler: they are refused inside the transaction.
  Take what you need from the payload, or react to another event.
- **Order-independent and idempotent in effect**: filter by state ("cancel what is still
  CONFIRMED", "delete what still exists"); an operator replay delivers an event again.
  A handler that records events of its own does it through its port in the same
  transaction (houses' `removeAllOf` announces each deleted house).
- Use cases a consumer calls take `actor: ServiceActor` first, so no request can reach
  them; no controller or `@ModuleApi` exposes them.

### Delivery semantics

- The `EventDispatcher` polls `events.deliveries` every `EVENTS_POLL_MS` (500 ms) when idle,
  takes up to `EVENTS_BATCH` (50) due rows per round, oldest first, each in its own
  transaction (`FOR UPDATE SKIP LOCKED`, so replicas never take the same row). A handler
  runs in a fresh request context with the publishing request's id and trace.
- A failed handler rolls back; the attempt is counted outside it. Transient failures
  (`ConcurrencyError`, `DependencyUnavailableError`, `RateLimitedError`, database
  conflicts and timeouts) and unknown errors (`HANDLER_FAILED`) retry after 1 s, doubling
  to at most 5 min (`retryDelayMs`). A delivery becomes a **dead letter** after
  `MAX_ATTEMPTS` (10), or at once for a failure that cannot go away: any other
  `DomainError`, `CROSS_MODULE_CALL_IN_TRANSACTION`, `EVENT_TYPE_NOT_HANDLED` (no handler
  any more), `EVENT_PAYLOAD_INVALID` (the payload no longer matches the schema) or
  `UNEXPECTED_PRODUCER`.
- The app logs `will retry <subscriber> <type> <eventId> (attempt n): <reason>: <message>`
  (warn) and `dead letter: ...` (error); the delivery keeps `<reason>: <message>` as
  `last_error`.
- Retention: delivered rows are kept 7 days (`DELIVERED_KEPT_DAYS`) for `events:status`;
  events are kept 21 days (`RETENTION_DAYS`) for replays once all their deliveries are done;
  an event with a pending or dead delivery is never purged.

### Operating events

```bash
pnpm events:status                                                     # per (subscriber, type): pending, due, dead, delivered, oldest, last error, handled
pnpm events:redrive --subscriber bookings --type houses.v1.HouseDeletedEvent      # dead letters due again, attempts reset
pnpm events:replay --subscriber houses --type users.v1.UserDeletedEvent --since 2026-10-01T00:00:00Z   # deliver again (or for the first time)
pnpm events:drop --subscriber <module> --type <type>                   # discard the pair's dead letters
```

Details, output and troubleshooting: `gam-local-stack`.
- **A new subscriber** gets deliveries for events published after it runs. During a
  rolling deploy, old instances publish without it; backfill with `events:replay` (the
  pair must have a handler in this build; events older than 21 days may be gone).
- **A new type**: deploy the producer and the consumers together (one app); nothing to
  register elsewhere.
- **Retiring a handler or a type** (a v1 every subscriber replaced with v2): remove the
  handler; deliveries still pending for it dead-letter with `EVENT_TYPE_NOT_HANDLED`, and
  `events:status` shows the pair as not handled; `events:drop` them. Then the producer
  stops publishing the old type.
- **No health checks** for events: a stuck delivery never takes the API out of rotation;
  lag shows in `events:status` and in the logs.
