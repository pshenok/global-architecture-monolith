# ADR-0002: A modular monolith: module boundaries and communication

- Status: Accepted
- Date: 2026-10-30

## Context

`global-architecture` runs each domain as a gRPC service with its own database. That buys
independent deploys and scaling at the price of a network hop per call, workload identity
on every hop, an event bus service, per-service databases and a stack of processes to run.
For a product with one team, or before the domains settle, those costs come first and the
benefits later. This repository runs the same domains as one deployable, and keeps the
boundaries a split would need, so that any module can become a service when there is a
reason to.

## Decision

1. **One process, one database, a schema per module.** `apps/api` mounts every feature
   module (`modules/*`) on the platform kit (`packages/platform`). Each module keeps its
   tables in its own Postgres schema (`users`, `houses`, `bookings`) with its own
   migration history (`drizzle.__<module>_migrations`); the platform keeps its own
   (`events`). No foreign key, join or query crosses schemas; references to another
   module's entities are plain ids (`owner_id`, `guest_id`).
2. **A module is a workspace package** (`@gam/<module>`) whose `package.json` `exports`
   `src/index.ts`: its Nest module, its event types, its migrations, its public API class
   when other modules need it, and the platform ports it implements for the app
   (`UsersIdentityResolver`). Everything else in the module is private. An operator entry
   (`@gam/users/ops`, the role CLI's code) may sit next to it; only apps import it.
3. **Modules call each other in process, through a public API** (`UsersApi`,
   `HousesApi`): Nest providers decorated with `@ModuleApi()`, exported from the module's
   Nest module, answering in the provider's language (`HouseSummary`), and taking the
   acting user where the provider decides visibility (`UsersApi.stillExists(actor)` asks
   as that user, so it cannot ask about anyone else). The calling module reaches it
   through a port in its own terms (`HouseCatalog.findTerms`) and an adapter in its
   `infrastructure/` (anti-corruption layer), so its use cases never see the other
   module.
4. **Modules never share a transaction.** A `@ModuleApi` method refuses to run inside the
   caller's transaction (`CrossModuleCallInTransactionError`): reads from other modules
   happen before the caller's single local transaction, and cross-module invariants are
   eventually consistent, through events (ADR-0005). This is the rule a network call would
   enforce by itself, and the one that keeps a split possible.
5. **Dependencies form a directed acyclic graph** of declared package dependencies
   (users <- houses <- bookings). A reaction that would close a cycle is an event.
6. **Snapshot immutable facts instead of asking for them.** When an authorization rule
   needs another module's data that never changes (a house's owner), copy it at creation
   time (`bookings.host_id`). If it becomes mutable, the owning module publishes an event
   that updates the copies.
7. **The guardrails are tools, not reviews.**
   - `tools/check-boundaries.ts` (in `pnpm lint`, on the TypeScript 7 parser, with
     probes): modules import each other only by package root and only when declared;
     relative imports never leave their package; module dependencies are acyclic;
     `pgSchema` is called only in a module's `src/infrastructure/persistence/schema.ts`,
     with its own schema, and `pgTable` (the `public` schema) and renamed imports of
     either are refused; its SQL strings name no other module's schema, nor the
     platform's `events` or `drizzle` schemas, in any case, quoted or spaced; every module
     is in `modules.json`, a dependency of the app, and imported by its `app.module.ts`
     (mounted) and `migrations.ts` (migrated).
   - Biome's layer rules: domain code imports `@gam/kernel` only; application code never
     imports the platform kit, another module, Drizzle or Fastify.
   - At run time, `@ModuleApi` refuses calls inside a transaction (every method and
     accessor, inherited and symbol-keyed ones included; a method written as a class
     field cannot be guarded, so the app refuses to start with one), and the app's tests
     check that every module of `modules.json` exports, among its classes, only its Nest
     module, `@ModuleApi` classes and implementations of platform ports.
8. **Modules are generated** from `templates/module` (`pnpm new:module`), which is itself
   compiled and tested on every run, and mounted in the app by the generator.

## Consequences

- One deploy, one process to scale, one database to back up. A module that needs its own
  scaling or release cadence moves out: its schema becomes a database, its public API a
  gRPC API, its events go through a bus, and nothing else changes shape, because nothing
  else ever reached past those boundaries.
- A referenced entity can disappear after it was checked (a house deleted while a booking
  is created). Deleted houses and users are reconciled through events (ADR-0005); a write
  that lands between the check and the cleanup can still stay orphaned.
- The boundaries cost some code a plain monolith would not have (ports, adapters,
  facades, events instead of one transaction). That is the price of keeping the split
  open; a domain that will never move out could drop it, but the guardrails apply to every
  module alike.
