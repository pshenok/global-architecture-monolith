# global-architecture-monolith

A modular monolith on Node 26 / NestJS 12: one HTTPS REST API (`apps/api`) built from
feature modules (`modules/*`) on one platform kit (`packages/platform`), each module with
its own Postgres schema and public API. Read the `gam-architecture` skill before changing
anything; it maps the repo and links the other `gam-*` skills.

## Commands

```bash
pnpm install                    # pinned Node 26 + pnpm 12 are fetched automatically
pnpm check                      # biome + check-access + check-boundaries + oxlint + typecheck + tests
pnpm build                      # SWC build (turbo-cached); runs an ESM link check per package
pnpm new:module <noun>          # new module from templates/module, mounted in the app
pnpm --filter @gam/<module> db:generate --name <change>   # after editing a module's schema.ts
pnpm stack:up && pnpm test:e2e  # the app locally (PM2): certificate, dev IdP, database, migrations, health
pnpm dev:token alice --email alice@example.com   # access token from the local dev IdP
pnpm users:grant-role <userId> admin            # platform roles live in the users module (users:revoke-role)
pnpm events:status                              # deliveries and dead letters (events:redrive, events:replay, events:drop)
```

## Rules that break production when ignored

- Domain code (`src/domain`) imports only `@gam/kernel`; application code never imports
  Drizzle, Fastify, the platform kit or another module. Ports are abstract classes bound
  in the module's composition root (`<module>.module.ts`).
- Constructor-injected classes are value imports; `import type` only for interfaces and
  types. Never enable Biome's `useImportType`. No circular imports (Biome fails them).
- Relative imports end in `.ts` and never leave their package. ESM everywhere.
- Fail with `DomainError` subclasses from `@gam/kernel` (stable UPPER_SNAKE reasons); their
  message and metadata reach API clients. Never throw HTTP exceptions from domain or
  application code.
- Concurrency-sensitive invariants are Postgres constraints + `translateDbError`;
  read-modify-write is `UnitOfWork.run` + `forUpdate`.
- A module's tables live in its own `pgSchema('<schema>')`; no SQL names another module's
  schema or the platform's `events` and `drizzle` schemas. Other modules are reached only
  through their package root (`@gam/<module>`), declared in package.json, through a port
  and an adapter, never inside a transaction (`@ModuleApi` refuses). Module dependencies
  are acyclic (`check-boundaries` in `pnpm lint`).
- Asynchronous reactions are events (ADR-0005): publish only through a domain-named port
  whose adapter calls `Outbox.add` inside `UnitOfWork.run`; declare event types in the
  producer (`src/contracts/`, exported from `src/index.ts`); consume only with `@OnEvent`
  in `src/transport/events`, listed in `EventsModule.forFeature({ consumers })`, passing
  `currentService()` to one use case; handlers are order-independent, idempotent in
  effect and call no other module.
- Every route declares `@Access` (`user`, `admin`, `identity` or `public(reason)`; the
  identity and public ones are listed in `security/public-endpoints.json`); an app with an
  undeclared route does not start. Never weaken the guard or add an auth bypass.
- Never take the acting user's id from a request: controllers pass `currentUser()` as
  the use case's first argument; rules live in the domain. Answer 404 when the caller may
  not know a resource exists; lists take a typed scope.
- Never cast to `UserActor`/`IdentityActor`/`ServiceActor`; only the platform kit mints
  actors (`check-access` in `pnpm lint` enforces it).
- Never edit applied migrations.
- Commit messages in English.

## Status

The same domain as `global-architecture` (users, houses, bookings), as one deployable.
Authentication and authorization are in place (ADR-0004): OIDC at the edge, users resolved
per request, `@Access` on every route. Asynchronous events are live (ADR-0005): deleting a
user or a house cleans up its houses and bookings within a second, in process.
