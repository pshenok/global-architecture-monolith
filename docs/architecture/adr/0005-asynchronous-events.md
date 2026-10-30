# ADR-0005: Asynchronous events

- Status: Accepted
- Date: 2026-10-30
- Derived from: ADR-0005 of `global-architecture` (event-bus-service), redesigned for one
  process and one database.

## Context

Some reactions cannot be calls without coupling modules or closing a cycle: when a house
is deleted, bookings must cancel its open stays; when a user is deleted, their houses and
their stays as a guest must go. ADR-0002 forbids modules from sharing a transaction and
from calling each other inside one, so these reactions are eventually consistent.

`global-architecture` delivers events through its own pub/sub service. Here the producer,
the subscribers and the queue all live in one process and one database, which allows a
simpler and stronger design: the outbox can record the deliveries themselves, and a
subscriber can apply an event and acknowledge it in one transaction.

## Decision

1. **Events are declared by their producer, as part of its public API.**
   `defineEvent('<module>.v<N>.<Aggregate><PastFact>Event', zodSchema)` in the producing
   module (`src/contracts/`), exported from its `src/index.ts`; subscribers import it from
   there. The first segment names the only module that may publish it. Payloads are JSON
   objects validated by their Zod schema on publish and on delivery; they carry domain
   facts and ids only (strings for ids and times), never PII or a principal. Changes are
   additive (new optional fields); a breaking change is a new type (`.v2.`).
2. **Transactional outbox with fan-out at publish.** A use case records a fact through a
   port in its own terms (`HouseEvents.deleted`); the adapter calls
   `Outbox.add(event, aggregateId, payload)`, which inserts the event into `events.events`
   and one row per subscribing module into `events.deliveries`, in the current
   `UnitOfWork` transaction, and refuses to run outside one, for another module's type,
   or for a payload that fails its schema, does not survive JSON, or is over 64 KiB. The
   event and its deliveries exist if and only if the change committed. Each module gets
   its own `Outbox` from `EventsModule.forFeature({ module, publish: true })`.
3. **Subscriptions are code.** A module lists its consumers in
   `EventsModule.forFeature({ module, consumers: [...] })`; each consumer's `@OnEvent(type)`
   methods are its handlers (at most one per module and type). The app's `EventRegistry`
   collects them at boot; a provider with `@OnEvent` handlers that no feature lists fails
   boot. The same features form a process-wide catalog the operator CLI reads without
   starting the app.
4. **Delivery: one transaction per delivery, effectively once.** The `EventDispatcher`
   polls `events.deliveries` (`EVENTS_POLL_MS`, 500 ms; `EVENTS_BATCH` per round) and, for
   each due row, in one transaction: claims it (`FOR UPDATE SKIP LOCKED`, so replicas never
   take the same row), runs the subscriber's handler in a fresh request context that acts
   as the module itself (`currentService()`, `currentEvent()`, the publishing request's id
   and trace), and marks the row delivered. The handler's writes and the acknowledgement
   commit together, so an event takes effect once per subscriber; a crash rolls both back
   and the row is due again. No `processed_events` table is needed.
5. **Failures.** A failed handler's transaction rolls back; the dispatcher then counts the
   attempt and either retries with backoff (1 s doubling to 5 min) or, when the failure
   cannot go away (a non-transient DomainError, a payload that no longer validates, no
   handler, a call to another module inside the transaction) or after `MAX_ATTEMPTS` (10),
   keeps the row as a dead letter. Transient errors (ABORTED, UNAVAILABLE,
   RESOURCE_EXHAUSTED, database conflicts and timeouts) and unknown ones retry.
6. **Handlers** live in `src/transport/events/`, call one use case with
   `currentService()` (cleanup use cases take a `ServiceActor`, so no request can reach
   them), call no other module (`@ModuleApi` refuses inside the transaction), must not
   depend on order, and should be idempotent in effect: an operator replay delivers an
   event again.
7. **Operations** (`apps/api/src/cli/events.ts`, per subscriber module and type):
   `pnpm events:status` (pending, due, dead, delivered, oldest pending, last error,
   whether the module still handles the type), `events:redrive` (dead letters due again),
   `events:replay --since <ISO time>` (deliver the pair's events again, or for the first
   time to a module that subscribed later; refused for a pair no module handles) and
   `events:drop` (discard dead letters). Each prints one line to keep.
8. **Retention.** Delivered rows are kept `DELIVERED_KEPT_DAYS` (7) for `events:status`;
   events are kept `RETENTION_DAYS` (21) for replays once all their deliveries are done;
   an event with a pending or dead delivery is never purged. Every replica purges hourly
   (deletes are idempotent).

### First flows

| Event                         | Producer | Subscribers      | Reaction                                                                                                       |
| ----------------------------- | -------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `users.v1.UserDeletedEvent`   | users    | houses, bookings | houses deletes the user's houses (each a HouseDeletedEvent); bookings cancels the user's open stays as a guest |
| `houses.v1.HouseDeletedEvent` | houses   | bookings         | bookings cancels the house's open stays                                                                        |

An open stay is CONFIRMED with check-out after today (UTC); finished stays stay as
history. A deleted host's stays are cancelled through its houses' events.

## Rejected alternatives

1. **An event bus service** (as in `global-architecture`): a network hop and a second
   source of truth for what is delivered, when the producer, the subscribers and the queue
   share one database.
2. **Synchronous cleanup in the deleting transaction**: strictly consistent, but every
   module would join another's transaction (ADR-0002 #4), a slow subscriber would slow
   the delete, and a failing one would fail it. Chosen against on 2026-10-30.
3. **A relay that fans out after commit**: one more step and one more lease, for nothing
   the publishing transaction cannot do itself.
4. **`processed_events` dedupe per subscriber**: needed when the acknowledgement is not in
   the handler's transaction; here it is.
5. **NestJS's in-memory EventEmitter**: events lost on a crash, no retries, no dead
   letters, no operations.
6. **LISTEN/NOTIFY for wake-ups**: lower latency, but a dedicated connection per replica
   and lost notifications on reconnect; polling at 500 ms is enough, and the dispatcher is
   where it would go.

## Consequences

- Reactions are eventually consistent: on the local stack they land within a second.
- A handler holds its row lock and a transaction for its duration; handlers do database
  work only (`DB_STATEMENT_TIMEOUT_MS` per statement, idle-in-transaction timeout twice
  that).
- During a rolling deploy, an instance of the old version publishes without a subscriber
  the new version added; `events:replay` delivers those events to it.
- A house or booking created between its existence check and the cleanup can stay
  orphaned (late writes). Tombstones checked on create are the follow-up if this matters.
- No ordering guarantee: handlers must be order-independent.
- When a module moves out to a service, its outbox and dispatcher move behind a broker
  (the `global-architecture` bus or another); the event types and handlers stay.
