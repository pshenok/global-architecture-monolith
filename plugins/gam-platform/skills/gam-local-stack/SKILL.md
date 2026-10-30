---

name: gam-local-stack
description: Run, observe and debug global-architecture-monolith locally - pnpm stack:up/down with PM2 (gam-api on https://localhost:9443, gam-dev-idp on http://127.0.0.1:9090) and local Postgres, db:setup (role gam with CREATEDB, databases gam and gam_test, --reset) and migrations, the dev TLS certificate, the local dev IdP and access tokens (pnpm dev:token), registering and granting admin with the role CLI, watch mode, logs with request ids, health checks, the events CLI (events:status/redrive/replay/drop for lag, dead letters, backfills, retired handlers), the shutdown budget, OpenTelemetry tracing, the Docker image, and troubleshooting (ports, pnpm release-age gate, Postgres roles, 401/403/503 auth errors, boot errors, events that do not arrive). Use it whenever someone wants to start, restart, inspect or debug the app locally, get a token, reproduce a bug end to end, read logs, see why an event or a cleanup did not happen, or when something fails to boot.
---

# Local stack

The whole system is two Node processes under PM2 against a local Postgres; no Docker or
cloud needed. Node 26 and pnpm 12 are pinned by `devEngines` and downloaded by pnpm. Ports
and PM2 names differ from global-architecture's, so both stacks run side by side.

## First run

```bash
pnpm install          # also installs the pinned Node 26 into node_modules/.bin
pnpm stack:up         # build -> .env files -> certificate -> db:setup -> migrations -> PM2 -> wait until ready
pnpm test:e2e         # prove it works end to end
```

`pnpm stack:up` (`tools/stack.ts up`) builds everything, creates missing `apps/*/.env`
from `.env.example`, makes the HTTPS certificate in `.certs/` (git-ignored; `pnpm certs`),
runs `db:setup`, applies every migration set with the stack's `DATABASE_URL`
(`postgresql://gam:gam@localhost:5432/gam`), then starts or reloads `ecosystem.config.cjs`:
- `gam-api`: `apps/api/dist/main.js` on `https://localhost:9443` (`modules.json`
  `api.httpsPort`), HTTP/2 + HTTP/1.1;
- `gam-dev-idp`: `tools/dev-idp.ts`, a local OIDC provider on `http://127.0.0.1:9090`
  (`devIdp.port`) that signs any subject it is asked for; loopback only, refuses
  `NODE_ENV=production`.

It waits up to 60 s until `/readyz` answers 200 with `status: "ok"` (the database answered
and the IdP's keys are loaded), then prints the API (`https://localhost:9443/v1/...`), the
docs (`/docs`) and the OpenAPI document (`/openapi.json`).

Prerequisite: Postgres 16+ on `localhost:5432` with a superuser login (`PG_ADMIN_URL`,
default `postgresql://$USER@localhost:5432/postgres`). `pnpm db:setup` creates the role
`gam` (password `gam`, LOGIN, CREATEDB), the databases `gam` and `gam_test` (marked with a
comment), and the extensions modules declare in `modules.json` (`btree_gist`) in `gam`.
The app, the migrations and the tests always connect as `gam:gam@localhost:5432` (each test
file creates and drops its own `gam_t_<random>` database from `gam_test`), so a Postgres
elsewhere needs a port forward to `localhost:5432`; changing `PG_ADMIN_URL` alone splits
the setup across two servers.

`pnpm db:setup --reset gam [gam_test] --yes` drops and recreates those databases (dev data
only); run `pnpm stack:up` afterwards to migrate. It refuses production, a Postgres that is
not local (loopback or a Unix socket), names other than `gam` and `gam_test`, and any
database `db:setup` did not create (no marker). An unmarked database owned by `gam` needs
`--adopt`. The marker cannot tell a shared server behind a localhost tunnel from your own,
so never reset through one.

## Signing in

Every route except the health probes and the house catalogue needs a token, and every
login registers once (`/docs` and `/openapi.json` are open).

```bash
TOKEN=$(pnpm -s dev:token alice --email alice@example.com)   # 900 s; --ttl <s> (max 3600), --unverified
curl -s --cacert .certs/dev-cert.pem -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"fullName":"Alice"}' https://localhost:9443/v1/users
curl -s --cacert .certs/dev-cert.pem -H "authorization: Bearer $TOKEN" https://localhost:9443/v1/users/me
pnpm users:grant-role <userId> admin --by <name>    # roles live in the users module, never in the IdP
pnpm users:revoke-role <userId> admin --by <name>
```

- Registration (`POST /v1/users`, 201 with the user's `id`) takes the email from the token
  and needs it verified: without `--email`, or with `--unverified`, it answers 403
  `EMAIL_NOT_VERIFIED`.
- The role CLI (`apps/api/src/cli/role.ts`, built to `dist/cli/role.js`, against
  `apps/api/.env`) prints one line, the only record of the change:
  `users: grant admin for user <id> by <who>; roles now [admin]`. Without `--by` it names
  the OS user. The change applies to the user's next request: the API resolves users and
  roles on every request, without a cache.

## Daily commands

```bash
pnpm stack:status                          # PM2 table
pnpm stack:logs                            # all logs
pnpm exec pm2 logs gam-api                 # one process (gam-dev-idp too)
pnpm turbo run build --filter=@gam/api... && pnpm exec pm2 restart gam-api   # after a code change
pnpm stack:down                            # stop and remove both processes
pnpm dev                                   # watch mode for the api (stop gam-api first: same port)
```

PM2 sets `NODE_ENV`, `LOG_PRETTY=false`, `HTTP_HOST`, `HTTP_PORT`, `TLS_ENABLED`, the
certificate files, `DATABASE_URL`, `AUTH_ISSUERS` (the dev IdP, audience `gam-api`),
`AUTH_JWKS_UNKNOWN_KID_COOLDOWN_S=1` and `OTEL_SERVICE_NAME=gam-api` for `gam-api`; values
in `apps/api/.env` apply only to variables PM2 does not set. `pnpm dev` reads only
`apps/api/.env`. Both start Node with `--import @gam/platform/telemetry`.

## Health

- `GET /healthz`: liveness, always `{ status: "ok" }`.
- `GET /readyz`: 503 `status: "starting"` until the database has answered once since start
  (a wrong `DATABASE_URL` never becomes ready), then 200 with `database` and
  `identityProvider` reported (`status: "degraded"` when one is not ok). It fails again only
  while shutting down. Probes are neither throttled nor logged and never read a token.

## Events (ADR-0005)

The `EventDispatcher` runs inside `gam-api`: it polls every `EVENTS_POLL_MS` (500 ms) when
idle and works through everything due before it waits again, so a whole cleanup (users ->
houses -> bookings) lands within about a second.

```bash
pnpm events:status                                                     # pending, due, dead, delivered, oldest pending, last error, handled
pnpm events:redrive --subscriber bookings --type houses.v1.HouseDeletedEvent      # dead letters due again, attempts reset
pnpm events:replay --subscriber houses --type users.v1.UserDeletedEvent --since 2026-10-01T00:00:00Z
pnpm events:drop --subscriber <module> --type <type>                   # discard the pair's dead letters
```

They run `apps/api/dist/cli/events.js` against `apps/api/.env` (`DATABASE_URL`), so build
first. They boot no app: they import the app module to learn which module handles which
type. Each change prints one line; keep it, it is the only record
(`events: redrove 2 dead letter(s) of <type> for <subscriber>`).
- `status` prints one row per (subscriber, type), or `no deliveries`. `handled` is `yes`, or
  `NO (drop its dead letters)` when this build has no handler for the pair any more.
- `redrive` and `drop` need both `--subscriber` and `--type` and touch dead letters only.
- `replay` needs `--since` as a full ISO time with a zone (`2026-10-01T00:00:00Z`,
  `2026-10-01T02:30+02:30`); it refuses a pair no module handles. It queues every event of
  the type since then (delivered ones included, or for the first time for a module that
  subscribed later). Events whose deliveries were all done are purged after 21 days
  (`RETENTION_DAYS`), so older ones are gone.
- **Lag**: `due` and `oldestPending` in `events:status`.
- **Dead letters**: after 10 attempts (`MAX_ATTEMPTS`, 1 s doubling to 5 min between them),
  or at once for a failure that cannot go away. Read the app's
  `dead letter: <subscriber> <type> <eventId> (attempt n): <reason>: <message>` line (or
  `lastError`), fix the cause, then `events:redrive`. The failed handler rolled back with
  its acknowledgement, so a redriven delivery runs once.
- **Shutdown budget**: on stop, the dispatcher waits for an in-flight delivery at most
  `EVENTS_DRAIN_MS` (default 5000, at most 14000). Keep it below PM2's `kill_timeout`
  (15000, Kubernetes `terminationGracePeriodSeconds` in a cluster). Past it the app logs
  `stopped with a delivery in flight; it rolls back and is due again`, which is harmless.
- Events register no health check: a stuck delivery never takes the API out of rotation.

## Following one request

```bash
curl -s --cacert .certs/dev-cert.pem -H 'x-request-id: debug-42' 'https://localhost:9443/v1/houses?pageSize=1'
grep -h debug-42 ~/.pm2/logs/gam-api-*.log
```

The app logs one JSON line per request (`requestId`, method, URL, status, response time;
4xx as warn, 5xx as error, `authorization` and `cookie` redacted) and echoes `x-request-id`.
An inbound id is kept when it matches `^[\w.:-]{1,128}$`, otherwise replaced. Events a
request records keep its request id (`recordedEvents` shows it; handlers run under it).

## Tracing (off by default)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (e.g. a local collector on `http://127.0.0.1:4318`) in
`apps/api/.env` (PM2 sets only `OTEL_SERVICE_NAME`) and restart: `@gam/platform/telemetry`
then exports HTTP, Postgres and Fastify spans and adds trace ids to log lines. Without the
variable it does nothing.

## Container

`docker build -f apps/api/Dockerfile -t gam-api .` from the repo root: `pnpm deploy --prod`
of the app into a distroless Node 26 image, non-root, `NODE_ENV=production`,
`HTTP_HOST=0.0.0.0`, `HTTP_PORT=8443`. Behind a TLS-terminating proxy set
`TLS_ENABLED=false`; otherwise mount a certificate (`TLS_CERT_FILE`, `TLS_KEY_FILE`). It
needs `DATABASE_URL` and `AUTH_ISSUERS`; `/docs` is off in production. The image does not
run migrations: run `node dist/migrate.js` with the same image as a release job, and the
role and events CLIs as `node dist/cli/role.js ...` and `node dist/cli/events.js ...`.

## Troubleshooting

| Symptom                                                                                         | Cause / fix                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`                                 | a version is younger than the 24 h `minimumReleaseAge`; pin the previous one in the catalog                                                                     |
| `ERR_PNPM_IGNORED_BUILDS`                                                                       | a new dependency has an install script; decide in `allowBuilds` (`pnpm-workspace.yaml`)                                                                         |
| `npm` errors with `EBADDEVENGINES` inside the repo                                              | use pnpm; npm enforces `devEngines` and the system Node is older                                                                                                |
| `Invalid configuration: - <VAR>: ...` at boot                                                   | env validation: see `apps/api/src/config.ts` (the platform's schema) and `apps/api/.env.example`                                                                |
| `TLS is enabled but ... cannot be read`                                                         | `pnpm certs`                                                                                                                                                    |
| browser warns about the certificate                                                             | install `mkcert` and run `pnpm certs --force` for a trusted one                                                                                                 |
| `stack did not become ready within 60s`                                                         | `pnpm stack:logs`; `/readyz` `starting` means the database never answered (Postgres down, wrong `DATABASE_URL`)                                                 |
| ``cannot create a test database from gam_test (run `pnpm db:setup`)``                           | run `pnpm db:setup` (creates the role and `gam_test`)                                                                                                           |
| `migrations of <set> failed: ...`                                                               | read the SQL error; a regenerated `init` already applied locally needs `pnpm db:setup --reset gam --yes`, then `pnpm stack:up`                                  |
| `EADDRINUSE`                                                                                    | another process holds the port (`gam-api` while `pnpm dev` runs?): `lsof -nP -iTCP:<port> -sTCP:LISTEN`                                                         |
| 401 `AUTH_TOKEN_MISSING` / `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED`                          | no `authorization: Bearer` header, a token not from the dev IdP (issuer `http://127.0.0.1:9090`, audience `gam-api`), or an expired one: `pnpm dev:token` again |
| 403 `USER_NOT_REGISTERED`                                                                       | the login has no user yet: `POST /v1/users` with that token                                                                                                     |
| 403 `EMAIL_NOT_VERIFIED` on `POST /v1/users`                                                    | `pnpm dev:token <sub> --email <address>`                                                                                                                        |
| 503 `IDENTITY_PROVIDER_UNAVAILABLE`; `dev-idp is not running: pnpm stack:up`                    | `gam-dev-idp` is down: `pnpm exec pm2 logs gam-dev-idp`                                                                                                         |
| `routes without an @Access policy: ...` at boot                                                 | add one `@Access` to each listed route method (`gam-http-endpoint`)                                                                                             |
| `... is an @OnEvent handler, but no EventsModule.forFeature lists ...`; `... is not a provider` | list the consumer in `forFeature({ consumers })` and in the module's `providers` (`gam-module-communication`)                                                   |
| `Nest can't resolve dependencies of X (?, ...)`                                                 | a constructor class imported with `import type`, a missing module import, or a circular import (`gam-architecture`)                                             |
| `does not provide an export named ...` at startup                                               | a type imported as a value; `pnpm build` runs `check-esm` to catch it                                                                                           |
| 500 with `... was called inside a transaction: modules never share one (ADR-0002)` in the log   | a `@ModuleApi` call inside `UnitOfWork.run` or a handler: read first, or react to an event                                                                      |
| `events:status` shows dead deliveries                                                           | read the `dead letter:` line for that event, fix the cause, `pnpm events:redrive --subscriber <m> --type <t>`                                                   |
| `events:status` shows `handled: NO (drop its dead letters)`                                     | no handler of that pair in this build: restore it, or `pnpm events:drop --subscriber <m> --type <t>`                                                            |
| `<module> has no handler of <type>: nothing to replay to`                                       | `events:replay` only targets pairs this build handles                                                                                                           |
| a cleanup never happens, nothing dead                                                           | `EVENTS_AUTOSTART=false` in `apps/api/.env`, or the subscriber was added after the event was published (no delivery row): `pnpm events:replay`                  |
