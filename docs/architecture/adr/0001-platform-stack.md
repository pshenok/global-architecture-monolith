# ADR-0001: Platform stack

- Status: Accepted
- Date: 2026-10-30

## Context

`global-architecture-monolith` is the modular-monolith sibling of `global-architecture`
(the microservices platform): the same stack, the same domain (users, houses, bookings),
the same rules for domain code, security and testing, but one deployable instead of a
service per domain (ADR-0002). The stack was chosen and verified for `global-architecture`
on 2026-10-22 (against the npm registry, release notes and small experiments: NestJS 12
boot, decorator metadata under TS 7 and SWC, Drizzle migrations against Postgres); this
repository pins the same versions, minus everything that only served calls between
services.

In `global-architecture` the data layer was re-checked the same day against Prisma 7.10.1, the Prisma 8
RC and Drizzle 0.45.4: hands-on runs against the booking-service schema, a
benchmark, and an independent cross-check of the findings. The benchmark ran on
a busy laptop, so absolute numbers are rough; the ratios quoted below held
across two passes and a separate serial re-run.

## Decision

| Area            | Choice                                                                                        | Why                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime         | Node 26 (LTS from 2026-10-28), pinned via `devEngines.runtime`                                | Node 24 entered maintenance on 2026-10-20; 26 is supported until 2029-04. pnpm downloads the pinned Node per repo.                                        |
| Package manager | pnpm 12 via `devEngines.packageManager`                                                       | Catalogs, `allowBuilds` allowlist, 24 h `minimumReleaseAge`, trust policy, strict unknown-setting checks.                                                 |
| Monorepo tasks  | Turborepo 2.11                                                                                | Cached `build/typecheck/test/lint`, strict env mode, single binary.                                                                                       |
| Module format   | ESM everywhere (`"type": "module"`, `nodenext`)                                               | NestJS 12 ships ESM-only.                                                                                                                                 |
| Framework       | NestJS 12.2 on Fastify 5                                                                      | Structured DI, guards, pipes and filters; one Nest module per feature module.                                                                             |
| Type checking   | TypeScript 7.0 (`tsc --noEmit`)                                                               | Native compiler, 2-3x faster. Decorator metadata verified identical to TS 5.9 and SWC.                                                                    |
| Emit            | SWC 1.16 (legacy decorators + metadata)                                                       | Same transpiler for build, tests and dev, so no metadata drift.                                                                                           |
| Tests           | Vitest 5 + unplugin-swc                                                                       | ESM-native; SWC keeps metadata identical to the build.                                                                                                    |
| Lint / format   | Biome 2.6 (format, imports, general lint) + oxlint type-aware rules (floating promises etc.)  | Fast; typescript-eslint does not support TS 7. `useImportType` is OFF because it breaks Nest DI.                                                          |
| Between modules | In-process calls to a module's public API (`@ModuleApi`), and in-process events (ADR-0005)    | No network hop, no codegen; the boundary is kept by packages, lint and a run-time guard (ADR-0002).                                                       |
| Edge            | HTTPS (HTTP/2 + HTTP/1.1) REST on Fastify 5, OpenAPI from Zod                                 | One public API; the same Fastify setup the gateway of `global-architecture` uses.                                                                         |
| Validation      | Zod 4 (Standard Schema)                                                                       | One schema system for env, REST DTOs and event payloads.                                                                                                  |
| Data            | PostgreSQL, one database, a schema per module, Drizzle ORM 1.0 (RC, exact pin), node-postgres | TS schema is the source of truth, SQL migrations reviewed in PRs, close to raw `pg` speed, non-interactive migration generation that works for AI agents. |
| Transactions    | `nestjs-cls` + `@nestjs-cls/transactional` behind a `UnitOfWork` port                         | Application layer stays ORM-free.                                                                                                                         |
| Identity        | OIDC access tokens (jose 6), `@Access` on every route (ADR-0004)                              | One login check at the edge, one policy per route, recorded at boot and checked by lint.                                                                  |
| IDs             | UUIDv7 generated in the application                                                           | Time-ordered, keyset-pagination friendly, known before insert.                                                                                            |
| Logging         | pino 10 + nestjs-pino, request id in AsyncLocalStorage, carried by events                     | Structured JSON, correlation from a request to the reactions its events cause.                                                                            |
| Tracing         | OpenTelemetry SDK, off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set                            | Zero cost by default.                                                                                                                                     |
| Local runtime   | PM2 for processes, local or Docker Postgres                                                   | No infrastructure needed to run the whole system.                                                                                                         |

## Rejected alternatives

- **Prisma 7.10**: the v7 line is in maintenance mode (fixes are promised for 18 months after Prisma 8 GA), and the next major is a rewrite (below). Findings on our stack: when the Postgres session `TimeZone` is not UTC, `@prisma/adapter-pg` silently shifts `timestamptz` values (Prisma reads its own writes back unchanged, so Prisma-only tests miss it; `-c TimeZone=UTC` on the pool fixes it). Exclusion and check violations surface as a generic P2039 without the constraint name, so `translateDbError` cannot map `bookings_no_overlap` without parsing the message text. It uses about 2x the CPU per operation of Drizzle 1.0 RC and reached 43-53% of raw `pg` throughput against 81-97%. Migrations can be generated without a human (`migrate dev --create-only --name <change>`, then `migrate deploy`), but `migrate dev` without `--name` hangs when there is neither a TTY nor a `CI` variable. Since 7.10.0 the `prisma` CLI package is published without npm provenance; `@prisma/client` and `@prisma/adapter-pg` still have it.
- **Prisma 8 (RC)**: a plain `npm install prisma` has installed it since 2026-08-25, but it is a different ORM (a contract file instead of PrismaClient; no `generate` or `migrate dev`). 26 RCs in two months with breaking changes in most of them, no GA date, and 13 `npm audit` findings in its dependency tree.
- **Drizzle 0.45 (stable)**: guaranteed breaking upgrade to 1.0, no node-postgres transaction fixes from 1.0 RC, and 45-58% of raw `pg` throughput. We use only the core query builder, which is the part least affected by remaining RC changes. Fallback if RC churn hurts, rehearsed on 2026-10-22: pin `drizzle-orm@0.45.4` and `drizzle-kit@0.31`. The source compiles and all tests pass unchanged, but each migrations folder must first be converted to the `meta/_journal.json` layout; otherwise kit 0.31 silently generates a full baseline that omits hand-written SQL such as the exclusion constraint. Kit 0.31 also skips an ambiguous rename without a TTY (exit 0, no file written), and a database migrated by 0.45 needs a manual fix before returning to 1.0, because 0.45 records applied migrations without names and the 1.0 migrator applies them again.
- **gRPC between modules** (as in `global-architecture`): a network hop, codegen and workload identity for calls that never leave the process. A module that moves out to a service gets a gRPC API then; its in-process API is the shape that contract takes.
- **One flat `src/` (a classic layered monolith)**: cheapest to start, but nothing stops a change in one domain from reaching into another's tables, which is what makes a monolith hard to split later. Rejected on 2026-10-30 in favour of modules with enforced boundaries.
- **ESLint + typescript-eslint**: no TypeScript 7 support.
- **Jest**: needs experimental VM modules for ESM Nest; slower.
- **tsx / esbuild runners**: do not emit decorator metadata, so Nest DI breaks.
- **Nx**: heavier, its boundary rules depend on typescript-eslint; `tools/check-boundaries.ts` covers what we need on the TypeScript 7 parser.

## Consequences

- Drizzle is pinned to an exact RC; upgrades are deliberate and go through the template first. 1.0 has no GA date and formats still change inside the RC line (rc.5 moved migration snapshots from version 8 to 9).
- Open issue drizzle-team/drizzle-orm#6572 (Prisma 7 behaves the same): when a statement fails inside a transaction and the callback swallows the error, Postgres answers COMMIT with ROLLBACK, yet the transaction resolves as success and its writes are silently lost. Code inside `UnitOfWork.run` never catches a database error and carries on; it translates and rethrows, as the repositories do.
- TypeScript 7 has no compiler API yet, so tools that need it (Nest CLI schematics, Swagger CLI plugin) are not used. Our own generator replaces `nest g`.
- Known sharp edges are encoded in code and docs: injectable classes must stay value imports, and a column compared with `now()` keeps full timestamp precision (a value rounded to milliseconds can land after the `now()` of the transaction that looks for it).
