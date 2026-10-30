# sample-items module

Feature module that owns **sample items**, served at `/v1/sample-items`. Generated from
`templates/module` by `pnpm new:module`.

## Layout

| Path                  | Layer                                                               | May import                              |
| --------------------- | ------------------------------------------------------------------- | --------------------------------------- |
| `src/domain/`         | Entities, invariants, repository ports, domain errors               | `@gam/kernel` only                      |
| `src/application/`    | Use cases, ports to other modules (`application/ports/`)            | domain, `@gam/kernel`, `@nestjs/common` |
| `src/infrastructure/` | Adapters: Drizzle repositories, other modules' APIs, outbox         | anything but other modules' internals   |
| `src/transport/http/` | HTTP controller (`@Access` on every route), Zod schemas             | application, `@gam/platform`            |
| `src/transport/api/`  | The module's public API for other modules (`@ModuleApi`)            | application                             |
| `src/*.module.ts`     | Composition root (binds ports to adapters)                          | everything in the module                |
| `src/index.ts`        | Public API: the only file other modules and the app import          |                                         |
| `drizzle/`            | Generated SQL migrations of its `sample_items` schema (commit them) |                                         |
| `test/`               | HTTP/Postgres integration tests and fakes                           |                                         |

## Access (ADR-0004)

Every route declares `@Access.user()`: a registered user. A sample item belongs to the
user who created it; only that user and admins can read, change or delete it, and
everyone else gets 404. Lists are scoped by `sampleItemScopeFor` and page tokens are bound
to the caller. `test/sample-items.http.spec.ts` keeps five access cases: adapt them when
you reshape the domain, do not delete them. A public route needs
`@Access.public(reason)` and an entry in `security/public-endpoints.json`.

## Commands

```bash
pnpm --filter @gam/sample-items test         # unit + HTTP/Postgres integration tests
pnpm --filter @gam/sample-items db:generate  # schema.ts change -> new SQL migration
pnpm db:migrate                              # apply every module's migrations (needs a build)
```
