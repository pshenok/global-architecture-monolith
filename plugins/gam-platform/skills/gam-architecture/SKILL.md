---

name: gam-architecture
description: Map and ground rules of global-architecture-monolith (one NestJS 12 HTTPS API in apps/api built from feature modules in modules/* on the @gam/platform kit and @gam/kernel, a Postgres schema per module, @ModuleApi facades between modules, in-process events through the platform outbox, OIDC at the edge and @Access on every route). Use it first whenever you work in this repository or on a module generated from its template, even for a "small" change, and whenever you need to decide where code belongs, which package or module may import which, how errors, ids, pagination, logging, identity and access work, or which other gam-* skill applies.
---

# global-architecture-monolith: platform map

A pnpm + Turborepo monorepo of one Node 26 / NestJS 12 app on Fastify 5. The app is built
from feature modules that keep the boundaries a split into services would need: each has
its own Postgres schema, one public entry (`src/index.ts`), calls other modules only
through their `@ModuleApi` class, reacts to them through events, and never shares a
transaction with them. Every module is generated from one template and runs on one
platform kit, so a fix in the kit reaches every module.

## Repository layout

| Path                    | What                                                                                                                                                          | Package                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `apps/api/`             | The only deployable: composition root (`src/app.module.ts`), `main.ts`, the release step (`src/migrate.ts`, `src/migrations.ts`), the role and events CLIs    | `@gam/api`                                   |
| `modules/<name>/`       | A feature module: its Nest module, domain, use cases, HTTP controllers, public API, events, its own schema and migrations                                     | `@gam/<name>`                                |
| `packages/kernel/`      | Framework-free domain primitives: errors, actors, ports (`IdGenerator`, `Clock`, `UnitOfWork`), `Money`, pagination                                           | `@gam/kernel` (+ `@gam/kernel/testing`)      |
| `packages/platform/`    | Platform kit: config, logging, request context, HTTPS bootstrap, problem details, OIDC + `@Access`, DB + transactions + migrations, events, test helpers      | `@gam/platform` (+ `/testing`, `/telemetry`) |
| `templates/module/`     | The module template (`SampleItem` placeholder), compiled and tested on every run, never mounted                                                               | `@gam/sample-items`                          |
| `tools/`                | Generator, template check, db setup, local stack, dev certificate, dev IdP, guardrails (`check-access.ts`, `check-boundaries.ts`, `check-esm.ts`)             | run through the root `pnpm` scripts          |
| `tests/e2e/`            | End-to-end suite against the running PM2 stack                                                                                                                |                                              |
| `security/`             | `public-endpoints.json`: every route reachable without a registered user, with its reason                                                                     | checked by `pnpm lint` and the app's tests   |
| `modules.json`          | Registry: the app (`httpsPort` 9443, database `gam`), `devIdp.port` 9090, `testDatabase` `gam_test`, and each module's name, dir, package, schema, extensions | managed by `pnpm new:module`                 |
| `docs/architecture/`    | `overview.md`, ADR-0001..0005, `identity-providers.md` (the "why")                                                                                            |                                              |
| `plugins/gam-platform/` | These skills (linked into `.claude/skills`)                                                                                                                   |                                              |

## Modules today

```
users  <--  houses  <--  bookings        package dependencies (and calls) point left
  UsersApi.stillExists(actor)            called by houses and bookings
  HousesApi.findHouse(id)                called by bookings
users.v1.UserDeletedEvent   -> houses (removes the user's houses), bookings (cancels the guest's open stays)
houses.v1.HouseDeletedEvent -> bookings (cancels the house's open stays)
```

Postgres database `gam` holds the schemas `users`, `houses`, `bookings` (one per module),
`events` (the platform's) and `drizzle` (migration histories).

## Layers inside a module (dependency rule points inward)

```
transport/http    ->  application  ->  domain  <-  infrastructure
transport/api         (use cases,      (aggregates,    (Drizzle repositories in the
transport/events       ports to other   invariants,     module's pgSchema, adapters
(controllers,          modules, event   repository      of other modules' APIs,
 @ModuleApi facade,    ports)           ports, errors)  outbox event adapters)
 @OnEvent consumers)
<module>.module.ts = composition root: binds every port to its adapter.
src/index.ts       = public entry: Nest module, event types, migration set, @ModuleApi classes.
```

- `src/domain/` imports only `@gam/kernel` and other domain files. Biome's
  `noRestrictedImports` override in `biome.json` blocks `@nestjs/*`, `drizzle-orm`, `pg`,
  `fastify`, `zod`, `nestjs-cls`, every `@gam/*` except the kernel, and the other layers.
- `src/application/` may import domain, `@gam/kernel` and `@nestjs/common`; never Drizzle,
  `pg`, Fastify, `@nestjs/swagger`, `@nestjs-cls/*`, `@gam/platform`, another module,
  infrastructure or transport.
- Between packages, `tools/check-boundaries.ts` (in `pnpm lint`): another module is
  imported by its package root only and only when `package.json` declares it, relative
  imports never leave their package, module dependencies form a DAG, `packages/*` never
  depend on a module, nothing depends on the app. Only apps may use a module's subpath
  exports (`@gam/users/ops`).
- Ports are **abstract classes**, so they double as Nest DI tokens:
  `constructor(private readonly users: UserRepository)` needs no `@Inject()`.
- Lint cannot see everything (an unexpected npm package in the domain, a cross-layer import
  through a re-export), so reviewers still check the direction of dependencies.

Details and examples: `gam-domain-logic`; between modules: `gam-module-communication`.

## Non-negotiable conventions (each one prevents a real bug)

- **ESM + `.ts` import specifiers** (`import { X } from './x.ts'`); SWC rewrites them.
- **Injectable classes are value imports.** `import type { UserService }` compiles, but
  decorator metadata becomes `Object` and Nest DI breaks. Interfaces and type aliases are
  `import type` (`verbatimModuleSyntax`). Biome's `useImportType` is off; keep it off.
- **No circular imports** (Biome `noImportCycles`). Extract the shared part into a third
  provider or a port.
- **Errors**: business failures throw a `DomainError` subclass from `@gam/kernel` with an
  UPPER_SNAKE `reason`. The platform's `ProblemDetailsFilter` (the app's only exception
  filter) maps it to an HTTP status and RFC 9457 problem+json with `code`. Never throw HTTP
  exceptions from domain or application code. Unexpected errors become 500 `INTERNAL`
  without internals.
- **Ids** are UUIDv7 from the injected `IdGenerator`; **time** comes from the injected
  `Clock` (both bound by `PlatformModule`).
- **Pagination** is keyset (`id < cursor ORDER BY id DESC`) with opaque page tokens bound
  to the filter and, for private lists, to the caller (`keysetPaging` in `@gam/platform`,
  built on the kernel's `filterFingerprint`, `encodePageToken`, `decodePageToken`,
  `resolvePageSize`, `toPage`). Default 20, max 100.
- **Money** is integer minor units (`Money`, `money()`, `multiplyMoney()` in `@gam/kernel`).
- **A schema per module.** A module's tables live in its own `pgSchema('<schema>')`. No SQL
  string in a module names another module's schema, `events` or `drizzle`; no foreign key
  or join crosses schemas; references to other modules' entities are plain ids.
- **Calls form a DAG and never run inside a transaction; reactions are events** (ADR-0002,
  ADR-0005). A `@ModuleApi` method refuses to run inside the caller's transaction
  (`CrossModuleCallInTransactionError`). When a module must react to what happened in
  another, the producer records an event with `Outbox.add` in the change's transaction and
  the consumer handles it with `@OnEvent`, delivered in process by the `EventDispatcher`.
- **Invariants that involve concurrency live in Postgres** (unique, check, exclusion
  constraints) and are translated with `translateDbError`; check-then-insert is a race.
  Read-modify-write is `UnitOfWork.run` + `findById(id, { forUpdate: true })`. Inside
  `UnitOfWork.run` never catch a database error and carry on (ADR-0001, drizzle-orm#6572).
- **Config** is one Zod schema validated at boot: `apps/api/src/config.ts` is
  `withPlatformChecks(platformConfigSchema)`. Modules read no environment of their own
  today; a new variable extends the schema before `withPlatformChecks` and goes into
  `apps/api/.env.example`.
- **Logging**: `new Logger(MyClass.name)` from `@nestjs/common` (routed to pino with the
  request id). One line per request already exists (probes excluded); the
  `authorization` and `cookie` headers are redacted. Do not log payloads, PII or tokens.

## Identity and access (ADR-0004)

- **Authentication happens once, at the edge.** The platform's `AuthGuard` verifies OIDC
  access tokens of the providers in `AUTH_ISSUERS` and asks the `IdentityResolver` port for
  the login's user on every request that needs one (no cache). The users module implements
  it (`UsersIdentityResolver`), bound in `AppModule` through
  `PlatformModule.forRoot({ identities })`. Roles (`admin`) are data in `users.users`,
  never IdP claims.
- **Every route declares exactly one `@Access`** (`user`, `admin`, `identity`,
  `public(reason)`), on the method. An app with an undeclared route does not start, and
  there is no switch that turns the guard off.
- **Use cases take the actor first.** Controllers pass `currentUser()`; ownership and
  visibility rules live in the domain. A caller that may not know a resource exists gets
  404; a visible resource with a forbidden action gets 403. Lists take a typed scope.
- **Modules trust each other in process**: no tokens between them. A `@ModuleApi` method
  that answers about users takes the acting user (`UsersApi.stillExists(actor)`).
- **Actors are branded**: only the kit mints them; `check-access` refuses casts, literals
  and every other way of forging one in production code.
- **Public is a reviewed decision.** Every route that needs no registered user (public and
  identity) is listed with its reason in `security/public-endpoints.json`; `check-access`
  compares the list with the source, the app's test (`createTestApp` with
  `checkPublicEndpoints`) with what the guard enforces, and CODEOWNERS protects it.

Details: `gam-domain-logic` (rules), `gam-http-endpoint` (routes), `gam-testing` (access
tests), `gam-local-stack` (tokens, roles).

## Where does it go?

| You need to...                                    | Put it in                                                                               | Skill                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| A new feature module                              | `pnpm new:module <noun>`                                                                | `gam-new-module`           |
| A business rule                                   | domain aggregate or use case                                                            | `gam-domain-logic`         |
| Who may call a route, see or change a resource    | `@Access` on the route method; ownership, visibility and list scope in the domain       | `gam-domain-logic`         |
| A table, column, constraint or migration          | `src/infrastructure/persistence/schema.ts` + `drizzle/`                                 | `gam-database`             |
| A REST endpoint                                   | `src/transport/http/<plural>.controller.ts` + `<plural>.schemas.ts`                     | `gam-http-endpoint`        |
| Something other modules may ask of yours          | a `@ModuleApi` class in `src/transport/api/`, exported from `src/index.ts`              | `gam-module-api`           |
| Data or an action from another module             | a port in `application/ports`, an adapter in `infrastructure/` calling its `@ModuleApi` | `gam-module-communication` |
| A new event type                                  | `src/contracts/<noun>-events.ts` (`defineEvent`), exported from `src/index.ts`          | `gam-module-api`           |
| Record an event / react to another module's event | event port + outbox adapter / `@OnEvent` consumer in `src/transport/events`             | `gam-module-communication` |
| Tests                                             | `*.spec.ts` next to code, `test/*.spec.ts` for HTTP + Postgres, `tests/e2e`             | `gam-testing`              |
| Run / debug everything locally                    | `pnpm stack:up`                                                                         | `gam-local-stack`          |
| Review a change                                   |                                                                                         | `gam-code-review`          |
| Change the kit, template, versions or guardrails  | `packages/*`, `templates/module`, `pnpm-workspace.yaml`, `tools/check-*.ts`             | `gam-platform-maintenance` |

## Everyday commands (repo root)

```bash
pnpm install                 # Node 26 and pnpm 12 are downloaded automatically (devEngines)
pnpm check                   # lint (biome ci + check-access + check-boundaries + oxlint) + typecheck + tests
pnpm build                   # SWC build of everything (turbo-cached), ESM link check per package
pnpm --filter @gam/bookings test
pnpm stack:up                # the app on PM2: https://localhost:9443/docs
pnpm dev:token alice --email alice@example.com   # access token from the local dev IdP
pnpm events:status           # deliveries and dead letters
```

## Known gaps (do not paper over them)

- **Late writes after a delete can stay orphaned.** Creating a house or a booking checks
  that its owner, guest or house exists, then inserts; one created between that check and
  the delete's cleanup event is not cleaned up (ADR-0005). Tombstones checked on create are
  the follow-up if it matters.
- **No idempotency keys** on creates yet.
- **No image publishing or deployment infrastructure** yet (`apps/api/Dockerfile` builds
  the image; nothing ships it).

## If you know global-architecture

This repository is its modular-monolith sibling: same stack, domain and rules, one process.

| global-architecture                          | here                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| a gRPC service per domain, database each     | a feature module in `modules/`, a Postgres schema each, one database         |
| `.proto` RPCs between services               | a `@ModuleApi` class called in process (`gam-module-api`)                    |
| protobuf event payloads, `event-bus-service` | `defineEvent` + Zod, the platform's outbox and `EventDispatcher`             |
| the HTTPS gateway                            | each module's own controllers, served by `apps/api`                          |
| workload identity and `via` lists            | none: boundaries are kept by `check-boundaries` and `@ModuleApi` at run time |
| `services.json`                              | `modules.json`                                                               |
