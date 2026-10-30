# global-architecture-monolith

The modular-monolith sibling of
[global-architecture](https://github.com/pshenok/global-architecture): the same stack,
the same domain (users, houses, bookings), the same rules for domain code, security and
testing, but one NestJS 12 HTTPS API instead of a gRPC service per domain. Feature modules
keep the boundaries a split would need (their own Postgres schema, a public API, events
instead of shared transactions), enforced by lint, by the platform at run time and by
tests. Claude Code skills encode the rules.

```
 OIDC provider (locally: dev-idp :9090)
        │ access token
        ▼    HTTPS (HTTP/2 + HTTP/1.1), REST + Bearer token, problem+json
client ───────────────────────────────▶ apps/api :9443  (one process)
                                          │ AuthGuard: verifies the token, resolves the user,
                                          │ checks the route's @Access policy
              ┌───────────────────────────┼──────────────────────────┐
              ▼                           ▼                          ▼
        users module  ◀──UsersApi── houses module ◀──HousesApi── bookings module
              │                           │   ◀─────UsersApi───────────│
              ┊ UserDeletedEvent          ┊ HouseDeletedEvent          ┊
              └┄┄┄┄┄┄┄┄┄┄┄┄┄▶ outbox + EventDispatcher (in process) ┄┄┄┄┘
                                          ▼
                 Postgres `gam`: schemas users, houses, bookings, events
```

Deleting a user removes its houses and cancels its stays; deleting a house cancels its
stays. Both happen asynchronously, through in-process events (ADR-0005).

## Quick start

Prerequisites: Postgres 16+ listening on `localhost:5432` with a superuser login
(default `postgresql://$USER@localhost:5432/postgres`; `PG_ADMIN_URL` changes only the
login `pnpm db:setup` uses, while the app, migrations and tests connect as
`gam:gam@localhost:5432`), and any `pnpm` 10+ (the repo pins and downloads Node 26 and
pnpm 12 itself).

```bash
pnpm install
pnpm stack:up        # build, .env files, TLS certificate, databases, migrations, PM2 (api + dev IdP), wait until ready
pnpm test:e2e        # end-to-end checks over HTTPS
open https://localhost:9443/docs
pnpm stack:down
```

```bash
TOKEN=$(pnpm -s dev:token ann --email ann@example.com)   # a login at the local dev IdP
curl -s --cacert .certs/dev-cert.pem https://localhost:9443/v1/users \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"fullName":"Ann"}'
curl -s --cacert .certs/dev-cert.pem https://localhost:9443/v1/users/me -H "authorization: Bearer $TOKEN"
```

Every route except the health probes and the house catalogue needs a token, and every
login registers once (`POST /v1/users`). See ADR-0004 for who may do what. The ports
(9443, 9090) and PM2 names (`gam-api`, `gam-dev-idp`) differ from `global-architecture`'s,
so both stacks run side by side.

## What is inside

| Path                                                  |                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                                            | the monolith: composition root, `main.ts`, the release step (migrations), the role and events CLIs                                      |
| `modules/users`, `modules/houses`, `modules/bookings` | feature modules (accounts and logins, listings, reservations), each with its own Postgres schema and public API                         |
| `packages/kernel`                                     | domain primitives: errors, actors, ports, money, pagination                                                                             |
| `packages/platform`                                   | platform kit: config, logging, HTTPS bootstrap, problem details, OIDC + `@Access`, DB + transactions + migrations, events, test helpers |
| `templates/module`                                    | the module template used by `pnpm new:module` (a workspace package, tested on every run)                                                |
| `plugins/gam-platform`                                | Claude Code plugin with the platform skills (also linked into `.claude/skills`)                                                         |
| `docs/architecture`                                   | overview and architecture decision records                                                                                              |
| `security/`                                           | allowlist of routes reachable without a registered user (checked by `pnpm lint` and the app's tests)                                    |
| `tools`, `tests/e2e`                                  | generator, guardrails, template check, db setup, local stack, dev IdP, end-to-end suite                                                 |

## Stack

Node 26, pnpm 12 + Turborepo, TypeScript 7 (type checking) + SWC (emit), NestJS 12 on
Fastify 5, Zod 4, Drizzle ORM 1.0 RC (exact pin) + node-postgres, jose (OIDC), pino,
OpenTelemetry, Vitest 5, Biome + oxlint, PM2 for the local stack. Why each was chosen:
`docs/architecture/adr/0001-platform-stack.md`.

## Everyday commands

```bash
pnpm check                         # lint (Biome, check-access, check-boundaries, oxlint) + typecheck + tests
pnpm build
pnpm new:module review             # scaffold modules/reviews from the template and mount it in the app
pnpm template:verify               # prove the template still generates a green, mounted module
pnpm --filter @gam/bookings test
pnpm --filter @gam/houses db:generate --name <change>      # after editing a module's schema.ts
pnpm stack:status | pnpm stack:logs
pnpm dev:token <sub> --email <email>                       # token from the local dev IdP
pnpm users:grant-role <userId> admin                       # platform roles (users:revoke-role to remove)
pnpm events:status                                         # deliveries and dead letters (events:redrive, events:replay, events:drop)
```

## Working with Claude Code

Open the repo in Claude Code: `CLAUDE.md` and the `gam-*` skills load automatically.
Start from the `gam-architecture` skill. To use the skills in another repository (you
need read access to this GitHub repository):

```text
/plugin marketplace add pshenok/global-architecture-monolith
/plugin install gam-platform@global-architecture-monolith
```

## Status and known gaps

Verified: every package's tests (on real Postgres), the template check, the PM2 stack with
the end-to-end suite. CI (`.github/workflows/ci.yml`) runs the same gate on every push and
PR. Not built yet, by design of this first iteration:
- tombstones against late writes: a house or booking created while its user or house is
  being deleted can stay orphaned (ADR-0005);
- idempotency keys for creates;
- image publishing and deployment infrastructure.
