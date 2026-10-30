---

name: gam-platform-maintenance
description: Maintain the global-architecture-monolith platform itself - upgrading dependency versions in the pnpm catalog under the supply-chain policy (minimumReleaseAge, allowBuilds, strict catalog; jose and Drizzle RC included), changing the @gam/platform kit or the kernel without breaking modules, keeping templates/module honest (pnpm template:verify, the generator's anchors), the kit's events and ModuleApi rules, the guardrails (check-access, check-boundaries and their probes, the run-time checks in createTestApp, CODEOWNERS), identity provider changes, the known sharp edges of the stack (TypeScript 7, SWC decorator metadata, ESM, Drizzle 1.0 RC, pnpm 12, Biome, Fastify, jose), splitting a module out, and recording decisions as ADRs. Use it for any dependency bump, Renovate/Dependabot PR, change under packages/, templates/ or tools/, toolchain or config change (tsconfig, .swcrc, biome.json, .oxlintrc.json, turbo.json, pnpm-workspace.yaml), IdP change or architectural decision.
---

# Maintaining the platform

The kernel, the platform kit, the template and the guardrails are shared by every module,
so a change there is a change to all of them. Make it once, prove it on the template, then
roll it out to the modules in the same PR.

## Dependency versions

Every version is in the `catalog:` of `pnpm-workspace.yaml` (`catalogMode: strict`,
`savePrefix: ""`); `package.json` files say `"x": "catalog:"`. To upgrade:
1. Edit the catalog version. pnpm refuses versions younger than 24 h
   (`minimumReleaseAge: 1440`); wait or pin the previous patch. `blockExoticSubdeps`
   refuses transitive dependencies from git or tarball URLs. Node and pnpm are not in the
   catalog: they are pinned in `package.json` (`devEngines`, `engines`),
   `.github/workflows/ci.yml` and `apps/api/Dockerfile`; bump all of them together.
2. `pnpm install`. With `strictDepBuilds`, a new package with an install script fails the
   install: decide in `allowBuilds` (allow only what needs it; deny telemetry like
   `@scarf/scarf`). `peerDependencyRules` documents each tolerated peer mismatch with a
   comment; revisit them on every bump.
3. Read the changelog for breaking changes, then run the full gate:

   ```bash
   pnpm check && pnpm build && pnpm template:verify
   pnpm stack:up && pnpm test:e2e
   git status                                  # the gate must leave the tree clean
   ```

Upgrade families together: the `@nestjs/*` packages at once (`common`, `core`,
`platform-fastify` and `testing` share one version; `swagger` and `throttler` follow their
own lines), `drizzle-orm` with `drizzle-kit` (same exact RC), `nestjs-cls` with
`@nestjs-cls/transactional` and its Drizzle adapter, the OpenTelemetry packages with
`@fastify/otel`, `vitest` with `vite` and `unplugin-swc`.
- **Drizzle (exact RC pin)**: upgrades are deliberate and go through the template first
  (ADR-0001). Formats still change inside the RC line (rc.5 moved migration snapshots to
  version 9). After a bump, every test database applies all committed migrations (the
  suites do), and `pnpm --filter @gam/<m> db:generate --explain` for each module (and for
  `@gam/platform`) must plan no change.
- **jose** does every OIDC verification (the platform's `auth/`, the test issuer, the dev
  IdP). Upgrade it on its own, read its changelog for changes in verification (algorithms,
  claim checks, key handling), and run `packages/platform/test/oidc.spec.ts`,
  `packages/platform/test/http.spec.ts` and the e2e suite (its key rotation test).
- **TypeScript**: `tools/check-access.ts` and `tools/check-boundaries.ts` use the unstable
  TypeScript 7 API (`typescript/unstable/sync`, `typescript/unstable/ast`); after a bump run
  `pnpm lint` and adapt the scripts if the API moved.

## Sharp edges (each was hit once; keep them fixed)

| Area                | Edge                                                                                                                                                         | Guard                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| TypeScript 7        | no compiler API yet: Nest CLI schematics, the Swagger CLI plugin and typescript-eslint cannot run                                                            | SWC builds, Biome + oxlint, our own generator, OpenAPI from Zod                    |
| Decorators          | `import type` of an injected class -> metadata `Object` -> Nest cannot resolve the dependency at boot                                                        | Biome `useImportType` off; review checklist                                        |
| ESM                 | circular imports of injectables crash at load                                                                                                                | Biome `noImportCycles`                                                             |
| ESM link            | a type imported as a value fails only in real Node ("does not provide an export named X")                                                                    | `tools/check-esm.ts` in every package's `build`                                    |
| Vitest              | Vite's own transform would emit different decorator metadata                                                                                                 | `unplugin-swc` in `vitest.shared.ts`                                               |
| Drizzle 1.0 RC      | relational query API still changing                                                                                                                          | core query builder only; exact pin                                                 |
| Drizzle migrator    | takes no lock; concurrent runs crash                                                                                                                         | `runMigrations` wraps it in a session advisory lock                                |
| drizzle-orm#6572    | a statement that fails inside a transaction whose callback swallows the error: COMMIT answers ROLLBACK, yet the transaction resolves and its writes are lost | never catch a database error inside `UnitOfWork.run` and carry on                  |
| Timestamp precision | a column rounded to ms can land after the `now()` of the transaction that looks for it                                                                       | `events.deliveries.available_at` keeps full precision                              |
| jose remote JWKS    | `createRemoteJWKSet` fetches on the request path and fails requests while the IdP is down                                                                    | `IdpKeySet`: background refresh, last good keys, 503 after `AUTH_JWKS_MAX_STALE_S` |
| Fastify deadlines   | Node's `requestTimeout` covers only plain HTTP/1, not HTTP/2 or TLS                                                                                          | `handlerTimeout` in `createAdapter` + 504 `REQUEST_TIMEOUT` in the filter          |
| Node timers         | a timer above 2^31-1 ms fires at once, timing every request out                                                                                              | `REQUEST_TIMEOUT_MS` capped at 600000                                              |
| Fastify docs page   | raw responses skip `onSend` hooks                                                                                                                            | `/docs` CSP set by a middleware in `http/openapi.ts`                               |
| pg pool             | an idle client error emitted on the pool crashes the process when unhandled                                                                                  | `pool.on('error', ...)` in `DatabaseModule`                                        |
| PM2                 | `@` in the interpreter path is read as an nvm version                                                                                                        | interpreter `node_modules/.bin/node`                                               |
| LibreSSL (macOS)    | writes private keys world-readable                                                                                                                           | `tools/dev-certs.ts` sets umask 077, `.certs/` 0700, files 0600                    |

## Changing shared code

- `packages/kernel`: pure and tiny; anything added becomes part of every domain's
  vocabulary. Never import a framework here.
- `packages/platform`: keep the public surface in `src/index.ts` (and the test helpers in
  `src/testing/index.ts`); prefer adding options with safe defaults over changing behaviour.
  Breaking a kit API means updating every module and the app in the same PR (they are all
  in this repo; `pnpm typecheck` lists them). The functions that mint actors
  (`userActorOf`, `identityActorOf`, `serviceActorOf`, `enterActor`,
  `enterEventDelivery`) stay unexported; `EventDispatcher` is exported only from
  `@gam/platform/testing`.
- `packages/platform/src/events` (ADR-0005): what every producer and consumer runs.
  - each delivery runs in a fresh request context (`cls.run({ ifNested: 'override' })`)
    acting only as the subscribing module, with the publishing request's id and trace;
  - the handler and the acknowledgement stay in one transaction (that is why no
    `processed_events` exists), and `CrossModuleCallInTransactionError` stays a dead letter
    (`classifyFailure` in `retry.ts`);
  - the schema lives in `src/events/tables.ts`; a change is a platform migration
    (`pnpm --filter @gam/platform db:generate --name <change>`), applied first everywhere
    through `PLATFORM_MIGRATIONS`;
  - `MAX_ATTEMPTS`, `retryDelayMs`, `RETENTION_DAYS` and `DELIVERED_KEPT_DAYS` are
    documented in ADR-0005 and the skills: change them together;
  - no health checks for events; shutdown stays bounded (`EVENTS_DRAIN_MS`, at most 14000,
    under PM2's `kill_timeout` of 15000).
- `ModuleApi` (`src/platform/module-api.ts`) detects the caller's transaction through
  nestjs-cls's `TransactionHost`; keep its test ("refuses a call inside the caller
  transaction, and only there") green when nestjs-cls moves.
- `templates/module`: after any change run `pnpm template:verify`. It generates
  `zz-template-check` (`modules/zz-template-checks`), mounts it, runs Biome, typecheck,
  oxlint, check-access, check-boundaries, its tests, builds the app and runs the app's
  typecheck and tests, then removes it and restores `modules.json`, `pnpm-lock.yaml`,
  `apps/api/package.json`, `apps/api/src/app.module.ts` and `apps/api/src/migrations.ts`,
  failing if it left anything behind. Existing modules are generated copies, not linked to
  the template: apply the same change to them. Keep what the generator relies on:
  `SampleItem` naming in every form, the five access tests, the package description
  `Sample items module (generated from templates/module by pnpm new:module).`, and the
  markers `// pnpm new:module adds feature modules` (`apps/api/src/app.module.ts`) and
  `// pnpm new:module adds migration sets` (`apps/api/src/migrations.ts`).

## Guardrails (never weaken them; extend them)

- `tools/check-access.ts` (in `pnpm lint`, TypeScript 7 checker, so names resolve through
  imports, renames, namespaces and aliases): (1) `@Access` only as a decorator on a route
  method with inline literal arguments, its metadata never touched, every public and
  identity route listed in `security/public-endpoints.json`; (2) no value of an actor type
  produced outside the kit; (3) production code never reaches the test helpers, never loads
  a module from a computed specifier or `createRequire`; (4) only the kit's
  `http/bootstrap.ts` and `http/openapi.ts` touch the raw server, Nest middleware or Nest's
  registries. Its probes (`modules/houses/test/access-probes`,
  `apps/api/test/access-probes`) are checked on every run: a line marked `// refused` must
  be refused, no other line.
- `tools/check-boundaries.ts` (in `pnpm lint`, TypeScript 7 parser): (1) module
  dependencies only on the kernel, the kit and other modules, acyclic; (2) imports by
  declared package root, relative imports inside the package, subpaths of a module only
  from apps; (3) one `pgSchema('<schema>')` per module, no `pgTable`, no SQL naming another
  module's schema, `events` or `drizzle`; (4) `modules.json`, the workspace and the app's
  dependencies agree. Its probes (`modules/houses/test/boundary-probes`, read as houses'
  `src`) and a synthetic cycle are checked on every run.
- Run time: the `AuthGuard` enforces the policies `AccessRoutes` recorded at boot;
  `createTestApp` fails on routes, hooks, plugins, handlers or middleware added outside the
  controllers by anything but packages and the two kit files, and with
  `checkPublicEndpoints` compares the open routes with the list it reads from the kit's own
  location (never the working directory); `@ModuleApi` refuses calls in a transaction;
  `apps/api/test/app.spec.ts` checks module exports, the migration order and the OpenAPI
  security.
- Biome's layer overrides (`biome.json`) and oxlint's `no-unsafe-*` rules (outside tests)
  keep `any` and wrong-layer imports out.
- When a review finds a new way around a rule: add a probe line marked `// refused`, then
  the rule. TypeScript is unsound, so a deliberate cast can still hide something; what
  defeats the checker at run time (`eval`) and edits to the guardrails are for CODEOWNERS.
- `.github/CODEOWNERS` requires the platform owner's review for `security/`, the whole kit
  (`packages/platform/src/`, `packages/platform/drizzle/`), the kernel's `actor.ts`,
  `testing.ts` and `index.ts`, the app's `app.module.ts` and `main.ts`, the probes,
  `modules.json`, `tools/check-access.ts`, `tools/check-boundaries.ts`, `tools/lib.ts`,
  `tools/verify-template.ts`, and everything that decides whether and how the checks run:
  package manifests, tsconfigs, `.swcrc`, vitest configs, `turbo.json`,
  `pnpm-workspace.yaml`, Biome and oxlint configs, the workflows and CODEOWNERS itself.
- Never add a switch that disables authentication; ADR-0004 rejects `AUTH_DISABLED`
  because agents would use it.

## Identity providers

Adding or changing a provider is configuration: an entry in `AUTH_ISSUERS` (one to five
issuers, so a migration can trust two at once; asymmetric algorithms only; https except
loopback outside production; an `emailPolicy`). See
`docs/architecture/identity-providers.md`. Keys rotate by themselves: the API refreshes each
JWKS in the background (`AUTH_JWKS_REFRESH_S`, 300), fetches early for an unknown `kid` (at
most once per `AUTH_JWKS_UNKNOWN_KID_COOLDOWN_S`, 30) and stops trusting keys it could not
refresh for `AUTH_JWKS_MAX_STALE_S` (1800, at least twice the refresh), answering 503,
never 401. Moving users to a new provider means inserting `users.identities` rows for the
new subjects before the API trusts the new issuer, never linking logins by email. Unlike
global-architecture, there are no workload keys to rotate: modules share one process.

## Splitting a module out

The boundaries exist for this (overview, "Growing"): its schema becomes a database, its
`@ModuleApi` an RPC API, its outbox and handlers move behind a broker, and every other
module changes one adapter per dependency. global-architecture is that end state for every
module; follow its skills for the service side.

## Recording decisions

Architectural decisions go to `docs/architecture/adr/NNNN-title.md` (Status, Date,
Context, Decision, Consequences, and the rejected alternatives). Update an ADR's status
instead of rewriting history. ADR-0001 records the stack, ADR-0002 the module boundaries,
ADR-0003 the API and errors, ADR-0004 identity and authorization, ADR-0005 events. The
`gam-platform` skills are the executable specification: update them in the same PR as the
convention they document.
