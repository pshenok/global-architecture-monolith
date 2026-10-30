---

name: gam-code-review
description: Review checklist for changes in global-architecture-monolith - layering and the dependency rule, module boundaries (public entry only, declared and acyclic dependencies, own pgSchema, no shared transactions), DI-safe imports, module public APIs and event contracts, access control (@Access on every route, public-endpoints.json, actors, 404 vs 403, scoped lists), error model, data integrity under concurrency, migrations, events (outbox in the change's transaction, @OnEvent handlers), HTTP API shape, tests, security and observability. Use it whenever asked to review a PR, diff, branch or a just-finished change in this repo (including your own work before declaring it done), or to check that a module follows the platform standards.
---

# Reviewing a change

Read the whole change: committed branch work with `git diff main...HEAD`, uncommitted work
(the usual case when reviewing your own change) with `git diff HEAD` plus `git status` for
new files, or the PR diff. Then walk the list. Report findings with file:line, why it
breaks in production, and the fix. Verify claims by running the relevant command rather
than guessing.

## Automated gate (must be green)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # lint = biome ci + check-access + check-boundaries + oxlint
pnpm template:verify                         # any change to templates/, packages/ or the app's wiring
pnpm stack:up && pnpm test:e2e               # changes to routes, auth, events, migrations or the stack
git status                                   # the gate must not leave changes behind
```

CI (`.github/workflows/ci.yml`) runs the same steps on pushes to `main` and on every PR,
against Postgres 18.

## Architecture and module boundaries

- [ ] Domain imports only `@gam/kernel` and domain files; application has no Drizzle,
  Fastify, platform kit or other module (Biome enforces it, but check new folders).
- [ ] Business rules live in aggregates or use cases, not in controllers, `@ModuleApi`
  facades, consumers or repositories.
- [ ] A new external dependency is a port (abstract class, domain terms) + an adapter +
  a binding in `<module>.module.ts`.
- [ ] Another module is imported by its package root only, declared in `package.json`, and
  the module graph stays acyclic (`check-boundaries`). A reaction that would close a
  cycle is an event.
- [ ] No SQL names another module's schema, `events` or `drizzle`; no foreign key or join
  across schemas; the module's tables are on its own `pgSchema`.
- [ ] No call to another module while a transaction is open: reads first, then one local
  `UnitOfWork.run` (`@ModuleApi` refuses at run time with
  `CrossModuleCallInTransactionError`; the review catches it before a test does).
- [ ] A new module is in `modules.json`, mounted in `AppModule`, its migrations in
  `apps/api/src/migrations.ts`, and in the export check of `apps/api/test/app.spec.ts`.

## Imports and DI (silent production breakers)

- [ ] Classes injected through constructors are value imports, never `import type`.
- [ ] Interfaces and types are `import type` (else an ESM link error at startup).
- [ ] No new circular imports between injectables.
- [ ] Relative imports use `.ts` specifiers and stay inside their package.

## Public API and contracts (`gam-module-api`)

- [ ] `src/index.ts` exports only the Nest module, migrations, `@ModuleApi` classes with
  their types, and event types; no aggregate, service, repository or table.
- [ ] `@ModuleApi` methods are async methods of the class, return summaries in the
  provider's terms (copies, not aggregates), take the acting user where the provider
  decides visibility, translate only expected outcomes, and delegate to use cases.
- [ ] Event types are named `<module>.v<N>.<Aggregate><PastFact>Event` with this module
  first, declared in `src/contracts/`, documented (what happened, aggregate id, who
  reacts); payloads are ids and facts, JSON-safe, no PII or actor; changes are
  additive (optional fields); a breaking change is a new `.v2.` type.
- [ ] REST fields and error reasons are only added, never renamed or repurposed; schema
  ids are unique across modules.

## Access (ADR-0004)

- [ ] Every new route method has exactly one `@Access`, the narrowest that works: `user`
  over `public`, `admin` for admin-only, `identity` only for registration.
- [ ] Anything open without a registered user (`public`, `identity`) is listed in
  `security/public-endpoints.json` with a real reason; the change goes to the code
  owners. Decorators are written directly on the method with inline literal
  arguments; `check-access` fails any other use, and the app's test compares the list
  with what the guard enforces.
- [ ] The acting user never comes from a request (body, query, path): controllers pass
  `currentUser()` as the use case's first argument, and new resources take their owner
  from the actor. `me` stands for the signed-in user.
- [ ] Rules live in the domain (`isVisibleTo`, `assertManageableBy`, scope functions);
  writes check them under the row lock.
- [ ] A resource the caller may not know about answers 404 with the same reason and
  message as a missing one; 403 only for visible resources and roles.
- [ ] Lists of private data take a typed scope in the repository; page tokens are bound to
  the caller and the scope.
- [ ] A `@ModuleApi` method never answers about users the request does not act for.
- [ ] Tests cover the access matrix: the five template cases per resource, each role and
  owner rule.
- [ ] No actor made outside the kit: `check-access` (type-aware) fails assertions and type
  predicates to types that are or hold an actor, `never` or type parameters; actor
  literals; calls and property reads that return an actor their declaration does not
  promise; definitely-assigned actor fields; actors from constructor injection, request
  parameters (any parameter of a decorated method) or typed callbacks; overloads,
  ambient declarations and augmentations. Biome and oxlint refuse `any`;
  `@ts-ignore`-style comments fail. No test helpers in production code, no raw routes,
  hooks or middleware, and no new way around the guard. TypeScript is unsound: if you
  see a new way to get an actor or a route past the checker, add a probe line marked
  `// refused` to `modules/houses/test/access-probes` or `apps/api/test/access-probes`,
  then the rule. Code that defeats types at run time (`eval`) and edits to the
  guardrails are yours to refuse.

## Events (ADR-0005)

- [ ] Events are recorded through a domain-named port whose adapter calls `Outbox.add`,
  inside the same `UnitOfWork.run` as the change and after it; a refused change records
  nothing.
- [ ] The producer imports `EventsModule.forFeature({ module: '<its name>', publish: true })`;
  consumers are listed in `forFeature({ consumers })` and in `providers`.
- [ ] Handlers are `@OnEvent` methods in `src/transport/events`, one per type per module,
  calling one use case with `currentService()`; no actor parameter, no call to another
  module, no business logic.
- [ ] Each handler is order-independent and idempotent in effect: it filters by state
  ("still CONFIRMED", "still exists"), so a replay changes nothing.
- [ ] Use cases only the module may run take `ServiceActor` first and are exposed by no
  controller or `@ModuleApi`.
- [ ] No module code reads or writes the `events` schema; only the kit does.
- [ ] A new subscriber or a renamed type comes with the operator steps (`events:replay` for
  a backfill, `events:drop` for a retired pair).
- [ ] Tests: the producer's `recordedEvents` after the request (and none after a refused
  one); the consumer's effect via `deliverEvent`, delivered twice without a second
  effect.

## Errors

- [ ] Failures are `DomainError` subclasses with UPPER_SNAKE reasons prefixed by the
  aggregate; existing reasons unchanged.
- [ ] The kind matches the caller's next step (invalid input vs. wrong state vs. conflict
  vs. retry).
- [ ] Messages and metadata are safe for API clients (no secrets, SQL, hostnames, other
  users' data); metadata values are strings.
- [ ] Another module's errors are translated where the use case expects them, not
  forwarded as this module's own reasons.

## Data integrity and migrations

- [ ] Uniqueness, overlaps and other concurrent invariants are named DB constraints +
  `translateDbError`, not check-then-insert.
- [ ] Read-modify-write uses `UnitOfWork.run` + `forUpdate`; nothing inside `run()` catches
  a database error and carries on.
- [ ] Migrations are generated (or custom SQL), reviewed, new files only; no edits to
  applied ones; the platform's set stays first.
- [ ] The change is safe during a rolling deploy (expand -> migrate -> contract); a NOT NULL
  column on a populated table goes expand -> backfill -> contract.
- [ ] Money in integer minor units; timestamps `timestamptz(3)`; ids from `IdGenerator`.
- [ ] List queries keyset-paginate on an indexed `(filter, id)` pair and cap the page size.
- [ ] A new extension is in a custom migration and in `modules.json` `extensions`.

## HTTP

- [ ] Every input has a Zod schema (`@Body/@Query/@Param({ schema })`) mirroring the domain
  limits, with `.meta({ id })` on bodies and views.
- [ ] Responses go through a view mapper; 201 + `Location` on create, `@HttpCode(204)` on
  delete, `@HttpCode(200)` on custom actions; lists use `keysetPaging` and `pageOf`.
- [ ] OpenAPI responses declared (`@ApiResponse` with `standardSchema`); 401/403 come
  automatically.
- [ ] No try/catch in controllers; no raw Fastify routes, hooks or middleware.

## Tests

- [ ] Domain and use-case tests for new rules; an HTTP + Postgres test for each new route
  and each documented error.
- [ ] A concurrency test for each new invariant, and a check that each guard's test fails
  without the guard.
- [ ] Fakes keep the real adapter's contract (its failures and scopes).
- [ ] Dates from a `FixedClock` in use-case tests; no `setTimeout` waits.

## Security and operations

- [ ] No secrets in code, config defaults, logs or error metadata; new env vars validated
  in `apps/api/src/config.ts` and listed in `apps/api/.env.example`.
- [ ] No tokens, keys or `authorization` headers in logs, messages or metadata; no IdP role
  or unverified email trusted beyond the issuer's `emailPolicy`.
- [ ] No unbounded inputs (lengths, page sizes, payload sizes).
- [ ] Logs carry business events, not payloads or PII.
- [ ] No switch that disables authentication (ADR-0004 rejects `AUTH_DISABLED`).
