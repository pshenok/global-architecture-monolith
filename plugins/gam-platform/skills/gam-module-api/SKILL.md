---

name: gam-module-api
description: Design and change a module's public API in global-architecture-monolith - what src/index.ts may export, the @ModuleApi facade class in src/transport/api (async methods, answers in the provider's language, takes the acting user where the provider decides visibility, never called inside a transaction), event types as public contracts in src/contracts (defineEvent with a Zod object, <module>.v<N>.<Aggregate><PastFact>Event naming, JSON-safe payloads, additive evolution, a new .v2. type for breaking changes), and the REST contract a module owns. Use it whenever another module needs something from yours, when you add, rename or remove an export, a ModuleApi method, an event type or an event field, when a payload or a public type changes shape, or when reviewing whether a module leaks its internals.
---

# A module's public API

A module is a workspace package (`@gam/<module>`) whose `package.json` `exports` point at
`src/index.ts`. That file is everything other modules and the app may import; the rest of
`src/` is private. `tools/check-boundaries.ts` refuses any import of another module other
than its package root, and the app's test (`apps/api/test/app.spec.ts`, "find in each
module public API only its Nest module and ModuleApi classes") fails when a module's entry
exports a class that is not its Nest module, a `@ModuleApi` class or an
`IdentityResolver`. That test imports the modules it checks by name (users, houses,
bookings): add a new module to it.

The public API has three parts, the in-process counterparts of a service's contract:
1. a `@ModuleApi` class: what other modules may **ask** (synchronous, in process);
2. event types: what other modules may **learn** (asynchronous, ADR-0005);
3. the module's REST routes: what **clients** may do (`gam-http-endpoint`).

It is designed like a network API even though nothing crosses a network: if the module
moves out to a service, its `@ModuleApi` becomes the RPC interface and its events go
through a broker, and no caller changes shape (ADR-0001, ADR-0002).

## `src/index.ts`

```ts
// modules/houses/src/index.ts
export { HOUSE_DELETED } from './contracts/house-events.ts';
export { HousesModule } from './houses.module.ts';
export { HOUSES_MIGRATIONS } from './migrations.ts';
export { type HouseSummary, HousesApi } from './transport/api/houses.api.ts';
```

- Always: the Nest module and the migration set (the app mounts and migrates them).
- When others need them: `@ModuleApi` classes with the types they take and return, and
  event types.
- Never: aggregates, services, repositories, schema tables, error factories, controllers.
  A caller that needs data gets a summary type in the API's own terms.
- The users module also exports `UsersIdentityResolver` (the platform's `IdentityResolver`,
  bound by the app) and has an operator entry `@gam/users/ops` that only apps may import
  (check-boundaries refuses subpaths of another module everywhere else).
- A module nobody calls exports only its Nest module and migrations (`@gam/bookings`).

## The `@ModuleApi` class

```ts
// modules/houses/src/transport/api/houses.api.ts
/** A house as other modules see it. */
export interface HouseSummary {
  readonly id: string;
  readonly ownerId: string;
  readonly maxGuests: number;
  readonly nightlyPrice: Money;
}

@ModuleApi()
@Injectable()
export class HousesApi {
  constructor(private readonly houses: HouseService) {}

  /** A house of the catalogue, or null when there is none with this id. */
  async findHouse(id: string): Promise<HouseSummary | null> {
    try {
      const house = await this.houses.get(id);
      return {
        id: house.id,
        ownerId: house.ownerId,
        maxGuests: house.maxGuests,
        nightlyPrice: { ...house.nightlyPrice },
      };
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }
}
```

Wiring: the class is in the Nest module's `providers` and `exports`
(`exports: [HousesApi]`), and in `src/index.ts`. Callers import the Nest module
(`imports: [HousesModule]`) to inject it (`gam-module-communication`).

Rules:
- **Every method is `async`** and returns plain data. `@ModuleApi()` wraps every method
  (inherited and symbol-keyed ones included) so that it rejects with
  `CrossModuleCallInTransactionError` when the caller has a transaction open
  (`UnitOfWork.run`, or an event handler); accessors throw it. A method written as a
  class field (`find = async () => ...`) cannot be wrapped, so the app refuses to start
  with one (`ModuleApiCheck`): declare every member as a method of the class.
- **Answer in the provider's language.** Return a summary type (`HouseSummary`), copies of
  values (`{ ...house.nightlyPrice }`), never an aggregate or a row. The caller's adapter
  maps it to its own terms (`HouseTerms`), so neither domain leaks into the other.
- **Translate expected outcomes into the answer** (a missing house is `null`) and let every
  other `DomainError` surface unchanged (ADR-0003): it reaches the client with its own
  status and reason unless the caller handles it.
- **Take the acting user where the provider decides visibility.** `UsersApi.stillExists(
  actor: UserActor)` runs the users module's own rule (`UserService.get(actor,
  actor.userId)`), so it can only answer about the user the request acts for. Never add a
  looser variant that takes a bare user id for data a user may not see; public data (the
  house catalogue) takes ids.
- **Delegate to use cases**, never to repositories: the facade is a transport like a
  controller, and business rules stay in the domain.
- **Never call it inside a transaction**: read what you need before `UnitOfWork.run`
  (`gam-module-communication`).
- **Evolve additively.** Add a method or an optional parameter; change a signature only
  together with every caller in the same PR (`pnpm typecheck` lists them), and prefer a new
  method while a module might move out.

## Event types (`src/contracts/`)

An event type is declared once, by its producer, and exported from its `src/index.ts`;
subscribers import it from there.

```ts
// modules/houses/src/contracts/house-events.ts
/**
 * A house is gone (ADR-0005): deleted by its owner or an admin, or with its owner's
 * account. Bookings cancels its open stays. Part of the module's public API: evolve it
 * compatibly.
 */
export const HOUSE_DELETED = defineEvent(
  'houses.v1.HouseDeletedEvent',
  z.object({
    houseId: z.uuid(),
    /** The owner (host) at the time of the delete. */
    ownerId: z.uuid(),
  }),
);
```

- **Name** `<module>.v<N>.<Aggregate><PastFact>Event` (`users.v1.UserDeletedEvent`).
  `defineEvent` throws at import for any other name. The first segment is the producer: it
  must equal the `module` the producer passes to `EventsModule.forFeature`, and
  `Outbox.add` refuses an event of another module (`<module> cannot publish <type>: <owner>
  owns it`). The constant is UPPER_SNAKE (`HOUSE_DELETED`, `USER_DELETED`).
- **Payload** is a `z.object(...)` of JSON values. It is stored as `jsonb`, so ids and
  times are strings (`z.uuid()`, ISO strings); `Outbox.add` refuses a payload that fails
  its schema, that does not survive a JSON round trip ("use strings for ids and times"),
  or that is over 64 KiB (`MAX_PAYLOAD_BYTES`).
- **Domain facts and ids only**: never personal data (`UserDeletedEvent` carries the
  `userId`, no email) and never an actor. The event id, producer, aggregate id, occur time,
  request id and trace are stored by the platform next to the payload; a handler reads
  them with `currentEvent()` (`id`, `type`, `producer`, `aggregateId`, `occurredAt`,
  `attempt`).
- **Document** on the declaration what happened, the aggregate id, and who reacts.
- **Changes are additive only**: add optional fields. Every delivery validates the stored
  payload against the schema the subscriber imports, so a new required field or a changed
  type turns events already recorded into dead letters (`EVENT_PAYLOAD_INVALID`). Never
  change or remove a field.
- **A breaking change is a new type**: `houses.v2.HouseDeletedEvent` (a new constant),
  published alongside v1 (two `Outbox.add` calls in the same port method) until every
  subscriber has moved to v2, then v1 is retired: remove the v1 handlers, then stop
  publishing it (`gam-module-communication` has the order).
- Publishing goes through a domain-named port and `Outbox.add`; handling through
  `@OnEvent` (`gam-module-communication`). The contract file holds the declaration only.

## REST contract

A module's routes are part of its public API too, served by the app under one OpenAPI
document. The module owns its paths (`/v1/<plural>`), its view and body schemas
(`src/transport/http/<plural>.schemas.ts`) and its error reasons. Conventions (ADR-0003):
- schema ids in `.meta({ id })` become `components/schemas/<id>` of the one document, so
  they must be unique across modules (`House`, `HousePage`, `CreateHouseBody`);
- responses go through a view mapper (`toHouseView`), never a raw aggregate;
- fields are added, never renamed or removed; a renamed field is a new field plus a later
  removal once clients moved;
- error `code`s are stable: changing an existing reason is a breaking change, so add a new
  one instead.

Routes, schemas and access: `gam-http-endpoint`.

## Checklist for a change

- [ ] `src/index.ts` exports only the Nest module, migrations, `@ModuleApi` classes and
  their types, and event types.
- [ ] New `@ModuleApi` methods are async, return summaries in the provider's terms, take
  the actor where visibility is decided, and translate only expected outcomes.
- [ ] Event names match `<module>.v<N>.<Aggregate><PastFact>Event` with this module as the
  first segment; payloads are ids and facts, JSON-safe, additive.
- [ ] Every caller of a changed method or type is updated in the same PR (`pnpm typecheck`).
- [ ] Tests: the facade's answers and its refusal inside a transaction (see users'
  "tells other modules whether the acting user still exists"), and the producer's
  recorded events (`gam-testing`).
