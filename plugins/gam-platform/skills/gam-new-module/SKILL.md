---

name: gam-new-module
description: Create a new feature module in global-architecture-monolith from the module template (generator `pnpm new:module <noun>`), what it creates and wires (modules/<plural>, modules.json, the apps/api dependency, AppModule, the migration sets), then turn the SampleItem-shaped scaffold into a real domain with access rules, schema, migrations, use cases, HTTP routes, a public API and events when other modules need them, and tests that keep the five access cases. Use it whenever someone wants a new module, feature, bounded context or "a separate part for X", or asks to split functionality out of an existing module, even if they do not say "generator" or "template".
---

# Create a new module

The template (`templates/module`, package `@gam/sample-items`) is a complete, tested module
for an aggregate called `SampleItem` that belongs to the user who created it. The generator
copies it, renames every form of the noun (`sample-item`, `sample_item`, `sampleItem`,
`SampleItem`, `SAMPLE_ITEM`, `sample item`, and the same forms of the plural), registers the
module and mounts it in the app. You then reshape the domain. Do not hand-copy an existing
module: generation keeps every module structurally identical, which is what keeps them
maintainable and splittable.

## 0. Decide the boundary first

A module owns one business capability and its data. Before generating, write down:
- the **aggregate(s)** it owns and their invariants;
- **who may do what**: which routes act for the signed-in user, who owns each resource,
  what admins may do, and whether anything is public (and why);
- which **other modules it calls** (only "downward": your module declares a dependency on
  theirs, and a cycle is refused; a back-reference is an event, see
  `gam-module-communication`);
- which **events it publishes or handles** (what others must learn when its data changes or
  disappears, and what it must clean up when theirs does);
- what **other modules may ask of it** (its `@ModuleApi`, see `gam-module-api`);
- which **data it must not own** (bookings stores `guest_id`, never user emails).

If the capability fits an existing module's aggregate, add an aggregate there instead
(`gam-domain-logic`).

## 1. Generate

```bash
pnpm new:module <noun>                    # e.g. review, payment-method (kebab-case, singular)
pnpm new:module person --plural people    # irregular plural
pnpm new:module review --no-register      # create the package only, do not mount it
pnpm new:module review --skip-install     # skip pnpm install and the initial db:generate
```

The noun must be kebab-case, must not end in `-module`, and its plural must differ from
it. The module is named after the **plural**:

| Output                                      | Example for `review`                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `modules/reviews/` (package `@gam/reviews`) | Nest module `ReviewsModule`, routes `/v1/reviews`                                                |
| Postgres schema                             | `reviews` (`payment-method` gives `payment_methods`)                                             |
| migration set                               | `REVIEWS_MIGRATIONS` = `migrationSet('reviews', ...)`, history in `drizzle.__reviews_migrations` |
| `modules/reviews/drizzle/<timestamp>_init/` | initial migration (`db:generate --name init`)                                                    |

Unless `--no-register`, it also:
- appends `{ name, dir, package, schema }` to `modules.json`;
- adds `"@gam/reviews": "workspace:*"` to `apps/api/package.json`;
- imports `ReviewsModule` in `apps/api/src/app.module.ts` above the marker
  `// pnpm new:module adds feature modules`;
- imports `REVIEWS_MIGRATIONS` in `apps/api/src/migrations.ts` above the marker
  `// pnpm new:module adds migration sets` (after the platform's and every earlier module's).

Then it runs `pnpm install` and the initial `db:generate` (unless `--skip-install`) and
formats what it touched with Biome. It refuses an existing folder, a taken name or schema,
and the reserved schemas `events`, `drizzle` and `public`. Then:

```bash
pnpm --filter @gam/reviews test     # the scaffold is green before you change it
pnpm --filter @gam/api test         # the app mounts it: wiring, migrations, open routes, OpenAPI
```

## What the scaffold already does for access (ADR-0004)

- Every route declares `@Access.user()` and passes `currentUser()` as the use case's first
  argument; the app does not start if a route has no `@Access`.
- The aggregate stores `ownerId` from the actor and answers `isVisibleTo(actor)`: the owner
  and admins see and change an item, everyone else gets 404 `<NOUN>_NOT_FOUND`.
- `src/domain/<noun>-scope.ts` turns the actor into the list scope (own items, or all for
  admins); the repository filters by it, and the controller binds page tokens to the caller
  (`keysetPaging(query, { userId: actor.userId })`).
- Names are unique per owner (`<plural_snake>_owner_id_name_key`), so a conflict never
  tells a user what other users named their items.
- `test/<plural>.http.spec.ts` keeps the five access tests in `describe('access')`:
  1. no signed-in user: 401 `AUTH_TOKEN_MISSING`;
  2. another user: get, update and delete answer 404 with the not-found reason;
  3. an admin (`api.as(STRANGER, ['admin'])`) reads and changes anyone's item;
  4. a stranger's list is empty, and the owner's page token replayed by the stranger is 400;
  5. a login without a user (`api.bearer('newcomer')`): 403 `USER_NOT_REGISTERED`.

## 2. Reshape, in this order

Run `pnpm --filter @gam/<plural> typecheck` after each step and the tests after step 7.
1. **Domain** (`src/domain/<noun>.ts`, `<noun>.errors.ts`, `<noun>.repository.ts`,
   `<noun>-scope.ts`): state, `create` / `restore` / behaviour methods, invariants throwing
   `ValidationError` or `PreconditionFailedError`, error factories with UPPER_SNAKE reasons
   prefixed by the aggregate, and the access rule: keep owner-or-admin, or replace it
   (`assertManageableBy` with 403 when the resource is visible to others, like houses).
   Follow `gam-domain-logic`.
2. **Use cases** (`src/application/<noun>.service.ts`): one method per use case, the actor
   first, ports for other modules and events in `src/application/ports/`.
3. **Persistence** (`src/infrastructure/persistence/schema.ts` + the repository): columns,
   constraints, indexes (an `(owner_id, id)` index serves the scoped list), all on the
   module's `<plural>Schema.table(...)`. Then replace the generated migration (it creates
   the placeholder columns `name`/`description`):
   `rm -r modules/<plural>/drizzle && pnpm --filter @gam/<plural> db:generate --name init`.
   If your local `gam` database already applied the placeholder (`pnpm stack:up` ran),
   reset it with `pnpm db:setup --reset gam --yes`, then `pnpm stack:up`. Once a migration
   has run anywhere shared, never regenerate it; add a new one. Follow `gam-database`.
4. **HTTP** (`src/transport/http/<plural>.schemas.ts`, `<plural>.controller.ts`): Zod
   schemas with `.meta({ id })`, views, one `@Access` per route method: `user()` by
   default, `admin()` for admin-only, `public('<reason>')` only for data anyone may read,
   with the same reason in `security/public-endpoints.json`. Follow `gam-http-endpoint`.
5. **Other modules** (if any): declare `"@gam/<other>": "workspace:*"` in the module's
   `package.json` (then `pnpm install`), import the other module's Nest module, add a port
   in `application/ports` and an adapter in `infrastructure/` that calls its `@ModuleApi`,
   bind it in `<plural>.module.ts`. Follow `gam-module-communication`.
6. **Your public API** (if other modules need it): a `@ModuleApi()` class in
   `src/transport/api/<plural>.api.ts`, in the Nest module's `providers` and `exports`, and
   exported from `src/index.ts`; event types in `src/contracts/`. Follow `gam-module-api`.
7. **Events** (if any, ADR-0005): `EventsModule.forFeature({ module: '<plural>', publish:
   true, consumers: [...] })` in the module's `imports`; an event port + outbox adapter to
   publish; `@OnEvent` consumers in `src/transport/events/` (also in `providers`) to handle.
   No tables to add: the platform owns the `events` schema. Follow
   `gam-module-communication`.
8. **Tests**: domain specs, use-case specs with fakes (`test/fakes.ts`) and test actors, and
   the HTTP + Postgres spec in `test/`. Keep the five access tests, adapted to your
   resources; add event specs when the module publishes or handles events. Follow
   `gam-testing`.
9. **Docs**: the module's `README.md` (purpose, routes, access rules, dependencies, events,
   owned tables), and the system views that list modules: the diagram and table in the root
   `README.md` and the containers diagram in `docs/architecture/overview.md`.

Search for leftovers when done; nothing named after the placeholder may remain:

```bash
grep -rniE "sample.?item" modules/<plural> && echo "leftovers!"
```

## 3. Definition of done

```bash
pnpm --filter @gam/<plural> typecheck
pnpm --filter @gam/<plural> test
pnpm --filter @gam/api test          # whole app: wiring, migrations order, open routes, OpenAPI
pnpm lint                            # biome ci + check-access + check-boundaries + oxlint
pnpm build
pnpm stack:up && pnpm test:e2e
git status                           # only your intended changes remain
```

- [ ] Every route has one `@Access`; anything public is listed in
  `security/public-endpoints.json` with its reason.
- [ ] No request field carries the acting user; use cases take `currentUser()` first.
- [ ] Hidden resources answer 404; lists are scoped; page tokens are bound to the caller.
- [ ] The five access tests pass, plus tests for each role and owner rule.
- [ ] `src/index.ts` exports only the Nest module, the migration set, event types and
  `@ModuleApi` classes (with the types they return), and the module is in the export
  check of `apps/api/test/app.spec.ts` (it lists modules by name).
- [ ] The schema is `pgSchema('<schema>')` from `modules.json`, and no SQL names another
  module's schema.

`pnpm stack:up` migrates every set listed in `apps/api/src/migrations.ts`, so a mounted
module needs nothing else to run locally.

## Things the generator cannot know

- **Multiple aggregates**: generate with the main noun, then add the others by hand in the
  same layered shape.
- **Postgres extensions** your migrations need: create them in a custom migration
  (`CREATE EXTENSION IF NOT EXISTS ... WITH SCHEMA public`) and add
  `"extensions": ["btree_gist"]` (yours) to the module's entry in `modules.json`, so
  `pnpm db:setup` pre-creates them in `gam` as the superuser.
- **Ownership**: add a `.github/CODEOWNERS` entry for `modules/<plural>` when a team owns it.
- **Removing a module**: first remove every consumer: other modules' dependencies on it,
  their adapters and ports for its `@ModuleApi`, and their `@OnEvent` handlers of its event
  types (and their `forFeature` consumers); deploy that. Then remove it from
  `apps/api/src/app.module.ts`, `apps/api/src/migrations.ts`, `apps/api/package.json` and
  `modules.json`, delete its entries in `security/public-endpoints.json`, delete
  `modules/<plural>`, run `pnpm install`, update the docs from step 9, and deploy.
  Deliveries still waiting for a handler that no longer exists dead-letter with
  `EVENT_TYPE_NOT_HANDLED`; `pnpm events:status` marks those pairs `handled: NO`, and
  `pnpm events:drop --subscriber <module> --type <type>` discards them. Its schema and its
  `drizzle.__<plural_snake>_migrations` history stay in the database until you drop them by
  hand when no environment needs the data.
