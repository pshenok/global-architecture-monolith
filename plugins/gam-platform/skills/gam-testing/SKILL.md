---

name: gam-testing
description: Testing strategy and helpers of global-architecture-monolith - Vitest 5 with SWC, domain unit tests, use-case tests with in-memory fakes of ports and test actors (@gam/kernel/testing), HTTP + real Postgres tests via @gam/platform/testing (createTestDatabase with a database per test file, createTestApp in modules or app mode with in-memory identities and as(userId, roles), bearer(), overrides of ports or other modules' APIs, checkPublicEndpoints), event tests (recordedEvents, deliverEvent, flushEvents), the five mandatory access tests, concurrency tests, tests that prove they can fail, and the end-to-end suite against the PM2 stack. Use it whenever you write, fix or review tests, when a change needs verification, when a test is flaky or slow, when a test fails with 401/403 or a boot error, or when someone asks "how do I test this" in any module, the platform or the app.
---

# Testing

Layers from fast to realistic; each catches bugs the others cannot. Every module from the
template has the domain, use-case and HTTP + Postgres layers; the app and the whole system
have their own suites.

| Layer       | Where                                                  | Runs against                                                                    | Example                                                         |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Domain unit | `src/domain/*.spec.ts`                                 | nothing                                                                         | `booking.spec.ts`, `stay.spec.ts`, `booking-scope.spec.ts`      |
| Use case    | `src/application/*.spec.ts`                            | in-memory fakes from `test/fakes.ts`, test actors                               | `booking.service.spec.ts`                                       |
| Module HTTP | `modules/<m>/test/*.spec.ts`                           | the real HTTP stack and `AuthGuard` (`createTestApp`), a real Postgres database | `bookings.http.spec.ts`, `booking-events.spec.ts`               |
| App         | `apps/api/test/app.spec.ts`                            | every module mounted, real identity resolution, all migrations                  | event cascade, open routes, OpenAPI, module exports             |
| Platform    | `packages/platform/test/*.spec.ts`, `src/**/*.spec.ts` | probe modules on the kit                                                        | `events.spec.ts`, `http.spec.ts`, `oidc.spec.ts`                |
| End to end  | `tests/e2e/*.e2e.spec.ts`                              | the running PM2 stack over HTTPS                                                | `stack.e2e.spec.ts`, `access.e2e.spec.ts`, `events.e2e.spec.ts` |

```bash
pnpm --filter @gam/bookings test              # one package (unit + HTTP/Postgres)
pnpm --filter @gam/bookings test src/domain   # just the domain
pnpm test                                     # everything (turbo, cached)
pnpm stack:up && pnpm test:e2e                # end to end
```

Postgres tests need the role `gam` and the `gam_test` database (`pnpm db:setup`); they
connect to `TEST_DATABASE_URL` (default `postgresql://gam:gam@localhost:5432/gam_test`).
Turbo caches test results; the `transit` task re-runs a package when a workspace package it
depends on (kernel, platform, another module) changes. Tests import workspace packages'
TypeScript sources through the `@gam/source` condition: no build needed.

## Use-case tests with fakes

Construct the service directly; no Nest needed. Actors come from `@gam/kernel/testing`
(`userActor(id, roles?)`, `adminActor(id)`, `identityActor(issuer, subject, email?)`,
`serviceActor(name)`), the only way to build one outside the platform kit:

```ts
const clock = new FixedClock();
service = new BookingService(
  repository,
  users,
  houses,
  new SequentialIds(),
  clock,
  new PassThroughUnitOfWork(),
);
await expect(service.get(userActor(STRANGER_ID), id)).rejects.toBeInstanceOf(NotFoundError);
await service.cancelOpenStaysOfHouse(serviceActor('bookings'), HOUSE_ID);
```

Fakes implement the same abstract port and the **same contract** as the real adapter,
including its failures (the in-memory booking repository rejects overlaps like the
exclusion constraint, and filters by the scope like the SQL). A fake more permissive than
production hides bugs. `SequentialIds` yields sortable UUID-shaped ids so pagination
behaves like UUIDv7. Event ports get a recording fake (`RecordingHouseEvents`,
`RecordingUserEvents`): assert the events a use case recorded, and that a refused one
recorded none. With a `FixedClock`, build dates from the clock (`day(30, clock.now())` from
`test/fakes.ts`), never from the real date, or "in the past" rules flip silently.

## Module HTTP + Postgres tests (the most valuable layer)

```ts
db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS, BOOKINGS_MIGRATIONS] });
api = await createTestApp({
  database: db,
  modules: [BookingsModule],
  overrides: new Map<InjectionToken, unknown>([
    [UserDirectory, new FakeUserDirectory(new Set([GUEST_ID, HOST_ID]))],
    [HouseCatalog, new FakeHouseCatalog()],
  ]),
});
beforeEach(() => db.truncate('bookings.bookings', 'events.events'));
afterAll(async () => {
  await api?.close();
  await db?.dispose();
});

const response = await api.inject({
  method: 'POST',
  url: '/v1/bookings',
  headers: await api.as(GUEST_ID),
  payload: body(10, 12),
});
expect(response.statusCode).toBe(201);
```

- `createTestDatabase({ migrations, baseUrl? })` creates a database of its own
  (`gam_t_<random>`) and applies the migration sets you pass (the platform's first). Test
  files never see each other's rows; `truncate('schema.table', ...)` empties tables between
  tests; `dispose()` drops the database. `pool` is a `pg.Pool` on it, for setup and checks.
- `createTestApp(options)` boots the real HTTP app (production adapter, `configureApp`,
  `AuthGuard`, filter, pipes) with TLS off, behind a local test issuer, with event delivery
  driven by hand (`EVENTS_AUTOSTART=false`). Options:
  - `database` (required); exactly one of `modules: [XModule]` (mounted on a test platform)
    or `app: AppModule` (the app's own root module);
  - `identities`: default in memory (any `as(userId)` works); `{ imports: [UsersModule],
    useExisting: UsersIdentityResolver }` with `modules`, or `'app'` with `app`, to resolve
    logins from the database;
  - `overrides: Map<token, fake>`: replace ports, or another module's API
    (`new Map([[UsersApi, { stillExists: async (actor) => known.has(actor.userId) }]])`);
  - `env`: extra variables (`{ DB_STATEMENT_TIMEOUT_MS: '300' }`). They are written into
    `process.env` and stay set for the rest of the test file;
  - `checkPublicEndpoints: true`: fail unless the open routes are exactly those of
    `security/public-endpoints.json` (the app's test uses it).
    It also fails when anything but the platform's `http/bootstrap.ts` and `http/openapi.ts`
    adds a route, hook, plugin, handler or middleware outside the controllers.

| `TestApp` member                                                      | Gives                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `as(userId, roles?)`                                                  | headers of a registered user (a fresh login mapped to `userId`); in-memory identities only              |
| `bearer(sub, { email?, emailVerified?, expiresIn?, audience?, ... })` | headers of a raw login: unregistered, or a bad or expired token (`expiresIn: -120`)                     |
| `inject({ method, url, payload?, headers? })`                         | a Fastify inject response (`statusCode`, `headers`, `json()`)                                           |
| `get(token)`                                                          | a provider (`api.get(HousesApi)`, `api.get(UnitOfWork)`)                                                |
| `issuer`, `identities`, `app`, `close()`                              | the test IdP (`rotate()`, `setDown()`, `setUserinfo()`), the in-memory resolver, the Nest app, shutdown |
- Dates relative to the real date (`day(30)`) keep "not in the past" rules green here, since
  the app's clock is real.
- Assert status and `code` for every documented error, and the field paths of `errors[]`.

## The five access tests (every module keeps them)

`templates/module/test/sample-items.http.spec.ts` ships them in `describe('access')`; a
generated module adapts them to its resources and never deletes them:
1. **No signed-in user**: 401 `AUTH_TOKEN_MISSING`.
2. **Another user**: get, update and delete answer 404 with the resource's not-found
   reason, as if it did not exist (or 403 where the resource is public, like houses).
3. **An admin** (`api.as(STRANGER, ['admin'])`) reads and changes anyone's resource.
4. **A stranger's list** is empty, and the owner's page token replayed by the stranger is 400.
5. **A login without a user** (`api.bearer('newcomer')`): 403 `USER_NOT_REGISTERED`.

Also cover every role and owner rule (bookings: guest, host, admin, stranger; `as=any`
only for admins). Build lists of failing calls so that each call starts when it is
awaited (an array of thunks, or `await` inside the array literal as the template does): an
array of bare promises starts every call at once, and a rejection that settles before its
`await` is reported as unhandled.

## Events (ADR-0005)

Helpers from `@gam/platform/testing` (tests run with `EVENTS_AUTOSTART=false`):

| Helper                                                                     | Use                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordedEvents(api, type?)`                                               | events recorded so far, oldest first: `{ id, type, producer, aggregateId, payload, requestId, deliveries[] }`                                                                                                                |
| `deliverEvent(api, { subscriber, event, aggregateId, payload, attempt? })` | records the event as its producer would, with a delivery to `subscriber` only, and delivers it now; returns `{ eventId, outcome }` (`'delivered'`, `'retry'`, `'dead'`, `'none'`, or `'lost'` when its lease was taken over) |
| `flushEvents(api, maxRounds = 20)`                                         | delivers every due event, round after round, so reactions to reactions run; returns how many; throws when still busy after `maxRounds`                                                                                       |
| `EventDispatcher` (`api.get(EventDispatcher)`)                             | `runOnce(limit)`, `deliverNext()` for finer control                                                                                                                                                                          |
- **Producer**: assert `recordedEvents` after the request, and that a refused request
  recorded nothing (houses: "records HouseDeletedEvent when the owner deletes a house, not
  when a stranger tries").
- **Consumer**: `deliverEvent` with the producer's event type; assert the effect and
  `outcome: 'delivered'`; deliver it again and assert nothing changed (an operator replay);
  data in the past goes in through `db.pool` (bookings' `insertStay`).
- **Whole flow**: the app's test deletes a host and expects `flushEvents(api)` to take 3
  deliveries (users -> houses -> bookings) with the same `requestId` on both events.
- Retries and backoff: move time with `update events.deliveries set available_at = now()`
  through `db.pool`. The kit's own behaviour (retries, dead letters, SKIP LOCKED, admin
  commands, purge, boot checks, `ModuleApi` refusal) is covered in
  `packages/platform/test/events.spec.ts`.

## Test what production will break on

- **Concurrency** for every invariant: fire N identical requests with `Promise.all` and
  assert exactly one winner (users: concurrent registrations of one email; bookings:
  overlapping requests). A constraint-backed invariant races on its own; for a row lock
  (`forUpdate`), hold the row from the test (`select ... for update` on a `db.pool`
  client) until every request waits on it (poll `pg_locks`), then commit (bookings: "lets
  exactly one of many concurrent cancels win").
- **Prove the test can fail.** A test of a guard must go red without the guard: remove the
  row lock, the scope filter, the constraint mapping or the `@Access` change, run the test,
  see it fail, restore. A test that stays green with the protection removed tests nothing.
- **Error contract**: status and `code` for every documented error of a route.
- **Access**: the five cases, every role and owner rule, and `CrossModuleCallInTransactionError`
  for a `@ModuleApi` called inside `api.get(UnitOfWork).run(...)` (users).
- **Pagination**: page through, check order, last `nextPageToken` null, a token reused with
  another filter, user or party: 400 `INVALID_PAGE_TOKEN`.
- **Partial updates**: unsent fields keep their values; concurrent updates of different
  fields both survive (the template's "serializes concurrent partial updates").
- **Database errors** nobody translated: a lock held past `DB_STATEMENT_TIMEOUT_MS` gives
  503 `DATABASE_TIMEOUT` (bookings' `database-errors.spec.ts`).

## End to end

`tests/e2e/client.ts`: `signUp(name)` registers a fresh dev-IdP login and returns a session
(`sub`, `userId`, `email`, `token`, `call(method, path, body)`); `grantAdmin(userId)` runs
`pnpm users:grant-role` (it applies to the session's next request); `idpToken(sub,
options)`, `bearer(token)`, `api(method, path, body, headers)` and `raw(path)` send raw
requests; `eventually(check, { timeoutMs = 15_000, intervalMs = 200 })` waits for the
effects of events (`events.e2e.spec.ts`, which first checks that `/readyz` says `ok`). The
suite runs its files one after another against `https://localhost:9443` (`E2E_BASE_URL`
overrides it), trusting `.certs/dev-ca.pem` (mkcert's root, or the self-signed certificate).

## Conventions and pitfalls

- `vi.mock` / `vi.hoisted` only at top level (Vitest 5).
- SWC (`unplugin-swc` in `vitest.shared.ts`) transforms tests, so decorator metadata equals
  production. If DI fails only in tests after a config change, clear Vitest's cache.
- Never use `setTimeout`-based waits for results; await the call. The one sanctioned wait
  is `eventually()` in `tests/e2e`; elsewhere use `vi.waitFor` on a database condition.
- Never point tests at the `gam` database or at the PM2 stack (except `tests/e2e`).
- `@gam/kernel/testing` and `@gam/platform/testing` are for tests and local tools only;
  `check-access` rejects them in production code.
