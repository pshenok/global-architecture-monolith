---

name: gam-domain-logic
description: How to write business logic inside a global-architecture-monolith module with clean architecture - aggregates and invariants in src/domain, use cases in src/application that take the acting user first, authorization rules (ownership, visibility, admin role, 404 vs 403, typed list scopes), ports as abstract classes (other modules' data, event ports that record what happened), module-only use cases taking a ServiceActor, DomainError kinds and reasons, validation split between transport and domain, UnitOfWork transactions, ids and time. Use it whenever you add or change a business rule, entity, aggregate, use case, error, permission or ownership check, status/state machine or validation in any module, or when deciding which layer a piece of code belongs to.
---

# Domain and application layers

Business logic must be testable without Nest, Fastify or Postgres, and must not depend on
another module's internals. That is why `src/domain` is plain TypeScript and
`src/application` only orchestrates through ports.

## Anatomy (bookings is the richest example)

```
src/domain/booking.ts            aggregate: state, create(), restore(), cancel(), isVisibleTo(actor), HouseTerms
src/domain/booking-scope.ts      who sees which rows: bookingScopeFor(actor, party) -> BookingScope
src/domain/stay.ts               value logic (date rules) as pure functions: nightsOf, openStayCutoff
src/domain/booking.errors.ts     error factories: bookingNotFound(id), datesUnavailable(houseId)
src/domain/booking.repository.ts persistence port (abstract class)
src/application/booking.service.ts             use cases, the actor as first argument
src/application/ports/house-catalog.ts         port for another module's data (HouseCatalog)
src/application/ports/user-directory.ts        port for another module's data (UserDirectory)
```

## Aggregates

```ts
export class House {
  private constructor(private state: HouseState) {}
  static create(input: {...}, now: Date): House  // validates and normalizes everything
  static restore(state: HouseState): House       // rebuilds from storage; trusts the DB
  update(changes: HouseChanges, now: Date): void // behaviour enforces invariants
  assertManageableBy(actor: Actor): void         // authorization rule: owner or admin
  toState(): HouseState                          // copy out for persistence and mapping
}
```

- State is private and only changes through intention-revealing methods (`cancel(now)`,
  `update(changes, now)`), so invariants cannot be bypassed.
- `now` is a parameter: the use case passes `this.clock.now()`, tests pass a fixed date.
- Normalize at the boundary of the aggregate (trim, lower-case emails, upper-case country
  codes) so stored data is canonical.
- Return copies from `toState()`; never hand out the mutable state.
- A state machine is a method that checks the current state:
  `if (this.state.status === 'CANCELLED') throw bookingAlreadyCancelled(this.state.id)`.
- Change types declare optional fields as `?: T | undefined` (`HouseChanges`), so a Zod
  output with absent keys passes under `exactOptionalPropertyTypes`.
- Rules that span many rows or need atomicity under concurrency (uniqueness, no-overlap)
  belong to the database (`gam-database`), not to an in-memory check.

## Actors and authorization (ADR-0004)

Who acts is a parameter, like `now`. The controller takes it from the verified request
(`currentUser()` from `@gam/platform`) and passes it as the use case's **first** argument.
Use cases and the domain never read request context, so every rule is visible in a unit
test and a second transport (a `@ModuleApi`, an event handler) cannot skip it.

```ts
// src/transport/http/houses.controller.ts
@Patch(':id')
@Access.user()
async update(@Param('id', { schema: IdParam }) id: string,
             @Body({ schema: UpdateHouseBody }) body: z.output<typeof UpdateHouseBody>) {
  return toHouseView(await this.houses.update(currentUser(), id, body));
}

// src/application/house.service.ts
update(actor: UserActor, id: string, changes: HouseChanges): Promise<House> {
  return this.unitOfWork.run(async () => {
    const house = await this.houses.findById(id, { forUpdate: true });
    if (!house) throw houseNotFound(id);
    house.assertManageableBy(actor); // the rule lives in the aggregate
    house.update(changes, this.clock.now());
    await this.houses.update(house);
    return house;
  });
}
```

- Actor types and helpers come from `@gam/kernel` (`Actor`, `UserActor`, `IdentityActor`,
  `ServiceActor`, `AnonymousActor`, `ANONYMOUS`, `Role`, `ROLES`, `isAdmin`,
  `adminRoleRequired()`), so the domain may use them. Verified actors are branded: only the
  platform kit creates them (the `AuthGuard` from checked tokens, the `EventDispatcher` for
  a module handling an event), and `check-access` fails any other way of making one.
- New data belongs to the actor (`ownerId: actor.userId`, `guestId: actor.userId`), never
  to an id from the request.
- Put each rule on the aggregate: `House.assertManageableBy(actor)` throws,
  `Booking.isVisibleTo(actor)` and `User.isVisibleTo(actor)` return a boolean and the use
  case throws its not-found error. Check writes under the row lock (`forUpdate`), so the
  check and the change cannot interleave.
- **404 or 403.** If the caller may not know the resource exists (bookings, users, the
  template's items), throw the same `NotFoundError` as for a missing one: same reason, same
  message. If the resource is visible to the caller (the public house catalogue) but the
  action is not allowed, throw a `PermissionDeniedError` (`HOUSE_PERMISSION_DENIED`).
- Admin-only: `if (!isAdmin(actor)) throw adminRoleRequired();` (403, reason
  `ADMIN_ROLE_REQUIRED`). Routes that are admin-only as a whole also say `@Access.admin()`.
- **Lists never fail on visibility.** A domain function turns the actor into a typed scope
  (`bookingScopeFor(actor, party)` -> `BookingScope`, `sampleItemScopeFor(actor)`), and the
  repository port takes the scope, so no list can forget to filter. Only asking for more
  than the actor may see fails (`party: 'any'` without the admin role ->
  `ADMIN_ROLE_REQUIRED`).
- A use case that checks scope or role before its first `await` is declared `async`, so a
  refusal rejects the returned promise instead of throwing synchronously
  (`BookingService.list`, `UserService.list`).
- Facts a rule needs from another module are snapshotted when they cannot change
  (`Booking.hostId` is the house owner at booking time), so the check needs no call.
- Unit tests build actors with `userActor(id, roles?)`, `adminActor(id)`,
  `identityActor(issuer, subject, email?)` and `serviceActor(name)` from
  `@gam/kernel/testing`; production code never imports it (`check-access`).

## Errors: pick the kind by what the caller should do

| Throw                                  | HTTP | When                                                                                                                                               |
| -------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ValidationError(message, violations)` | 400  | input is malformed regardless of system state (reason `VALIDATION_FAILED` unless given)                                                            |
| `NotFoundError`                        | 404  | the addressed resource does not exist, or the caller may not know that it exists                                                                   |
| `ConflictError`                        | 409  | a conflicting resource exists (unique key, overlapping range)                                                                                      |
| `PreconditionFailedError`              | 400  | valid input, but the system state forbids it (cancelled twice, referenced user or house missing, too many guests)                                  |
| `PermissionDeniedError`                | 403  | the caller may see the resource but not do this (`HOUSE_PERMISSION_DENIED`), or lacks a role (`adminRoleRequired()`)                               |
| `ConcurrencyError`                     | 409  | lost a race (serialization failure, deadlock: `TRANSACTION_CONFLICT`); safe to retry                                                               |
| `RateLimitedError`                     | 429  | a quota is exhausted                                                                                                                               |
| `DependencyUnavailableError`           | 503  | a dependency is down or slow: a statement timed out (`DATABASE_TIMEOUT`), the identity provider (`IDENTITY_PROVIDER_UNAVAILABLE`); nothing changed |
| `UnauthenticatedError`                 | 401  | raised by the platform only (token checks, `currentUser()` without a user); use cases always receive a verified actor                              |

Constructors: `new NotFoundError(reason, message, metadata = {}, options?)`, the same for
every kind except `new ValidationError(message, violations = [], reason =
'VALIDATION_FAILED')`. A reason must match `^[A-Z][A-Z0-9_]{0,62}$` (the constructor throws
otherwise); metadata values are strings.

Write a factory per error in `<noun>.errors.ts` with a stable UPPER_SNAKE `reason` prefixed
by the aggregate (`BOOKING_DATES_UNAVAILABLE`). Clients branch on `code` (the reason), so
never change an existing one. Messages and metadata are returned to API clients: write
them for API users, include only identifiers the caller already knows. Errors thrown by
another module's `@ModuleApi` are the same `DomainError`s; the adapter translates the ones
your use case expects (`gam-module-communication`).

## Validation: two layers, two jobs

1. **Transport** (`src/transport/http/<plural>.schemas.ts`, Zod, validated by the global
   pipe): shape and format. Is `id` a UUID, is a date `YYYY-MM-DD`, are numbers integers
   within range. Rejects garbage before any work and returns precise field violations.
2. **Domain** (aggregate methods and pure functions like `nightsOf`): business invariants,
   with the same limits, because the domain must protect itself whoever calls it (a
   controller, a `@ModuleApi`, a handler).

The duplication of a few limits is intentional; export the constants from the domain file
(`TITLE_MAX`, `MAX_GUESTS_LIMIT`, `FULL_NAME_MAX`) when you want one source.

## Use cases

```ts
@Injectable()
export class BookingService {
  constructor(
    private readonly bookings: BookingRepository, // ports: abstract classes
    private readonly users: UserDirectory,
    private readonly houses: HouseCatalog,
    private readonly ids: IdGenerator,            // from @gam/kernel, bound by PlatformModule
    private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async create(actor: UserActor, input: CreateBookingInput): Promise<Booking> { ... }
  async get(actor: UserActor, id: string): Promise<Booking> { ... }
}
```

- One public method per use case; it reads like the business process. A use case that acts
  for someone takes the actor first. One that only the module itself may run (an event
  reaction such as `cancelOpenStaysOfHouse`, `cancelOpenStaysOfGuest`, `removeAllOf`) takes
  `actor: ServiceActor` first: only the `EventDispatcher` mints one (`currentService()`),
  so no request can reach it, and no controller or `@ModuleApi` exposes it. Name it
  `_actor` when the rule does not read it.
- Do cheap local validation before calls to other modules (`nightsOf` first); run
  independent calls in parallel (`Promise.all`, as `BookingService.create` does).
- **Never call another module inside a transaction**: `@ModuleApi` refuses with
  `CrossModuleCallInTransactionError`. Ask first, then open the one local transaction.
- Read-modify-write goes inside `this.unitOfWork.run(...)` with
  `findById(id, { forUpdate: true })`, so concurrent updates serialize instead of
  overwriting each other. Repositories called inside `run()` join the transaction, and a
  nested `run()` joins the outer one too (no savepoint): an error anywhere rolls back
  everything. Inside `run()` never catch a database error and continue: translate and
  rethrow (ADR-0001).
- Single-statement writes (insert, delete) need no unit of work, unless they record an
  event.
- **Record events through a port, in the change's transaction** (ADR-0005). Other modules'
  reactions to what happened here are events, never calls into them: inject a domain-named
  port (`HouseEvents.deleted(house)`, `UserEvents.deleted(id)`) and call it inside the same
  `this.unitOfWork.run(...)` as the change, after the change (`HouseService.delete`). The
  adapter calls `Outbox.add`, so the event exists if and only if the change committed; a
  refused change (a thrown domain error) records nothing. Use-case tests pass a recording
  fake (`RecordingHouseEvents`, `RecordingUserEvents` in each module's `test/fakes.ts`).
- Imports allowed: domain, `@gam/kernel`, `@nestjs/common` (`Injectable`, `Logger`); Biome
  refuses the platform kit, other modules, Drizzle and Fastify here. Constructor
  parameters that are classes must be **value imports** (DI metadata); only interfaces
  and types use `import type`.

## Ports

A port is an abstract class named after what the domain needs, not after the provider:
`UserDirectory.stillExists(actor)`, `HouseCatalog.findTerms(houseId)`, not
`UsersApiClient`. Keep its types in domain terms (`HouseTerms` lives in
`domain/booking.ts`), which makes the adapter an anti-corruption layer and keeps another
module's API out of your domain. Bind it in `<module>.module.ts`:
`{ provide: HouseCatalog, useClass: HousesApiCatalog }`. Event ports work the same way:
`HouseEvents` says what happened in domain terms, and `OutboxHouseEvents`
(infrastructure) turns it into a payload through the platform's `Outbox`
(`gam-module-communication`).

## Logging inside use cases

```ts
private readonly logger = new Logger(BookingService.name);
this.logger.log(`booking ${id} cancelled`);
```

Every request already gets one structured line with its request id, status and duration,
so log business events, not entry and exit. Never log emails, names or tokens. Logging is
optional; when a use case logs, its unit tests (which construct the class without Nest)
print those lines unless the spec calls `Logger.overrideLogger(false)` in `beforeAll`.
