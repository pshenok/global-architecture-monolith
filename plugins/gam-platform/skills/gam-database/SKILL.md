---

name: gam-database
description: Postgres and Drizzle ORM (1.0 RC, core query builder) in global-architecture-monolith - one database with a pgSchema per module, schema.ts as the source of truth, drizzle-kit migrations per owner (generate, custom SQL, never push) with histories in drizzle.__<module>_migrations, the advisory-locked release step, constraints that enforce invariants, translateDbError, DbContext/UnitOfWork transactions (nested runs join the outer one), the platform-owned events schema, keyset pagination and scoped list queries, money/date/timestamp/role column types, schema isolation rules and zero-downtime schema changes (expand -> backfill -> contract). Use it for any table, column, index, constraint, migration, query, repository or transaction work, and whenever a race condition or data-integrity rule is involved.
---

# Database

The app uses one Postgres database (`gam` locally). Each module keeps its tables in its
own schema (`users`, `houses`, `bookings`, named in `modules.json`); the platform keeps its
own (`events`); the `drizzle` schema holds one migration history per owner. Nothing reads
or writes another owner's schema, and no foreign key or join crosses schemas, so a module
can later move to a database of its own. Drizzle's TypeScript schema is the single source
of truth; SQL migrations are generated from it, reviewed in the PR, and applied as a
release step.

## Files

```
modules/<m>/src/infrastructure/persistence/schema.ts                 pgSchema, tables, constraints, indexes
modules/<m>/src/infrastructure/persistence/drizzle-<noun>.repository.ts  adapter of the domain port
modules/<m>/src/migrations.ts                     <M>_MIGRATIONS = migrationSet('<m>', new URL('../drizzle', import.meta.url))
modules/<m>/drizzle/<timestamp>_<name>/migration.sql + snapshot.json   generated, committed
modules/<m>/drizzle.config.ts
apps/api/src/migrations.ts                        MIGRATIONS: PLATFORM_MIGRATIONS first, then every module in modules.json order
apps/api/src/migrate.ts                           release entrypoint (runMigrations)
packages/platform/src/events/tables.ts + packages/platform/drizzle/   the events schema (platform only)
```

## Schema per module

```ts
export const housesSchema = pgSchema('houses');
export const houses = housesSchema.table('houses', { ... }, (table) => [ ... ]);
```

`tools/check-boundaries.ts` (in `pnpm lint`) requires that a module's `schema.ts` declares
exactly one `pgSchema('<its schema from modules.json>')` and no `pgTable` (that would land
in `public`), and that no string literal in a module's `src` names another module's
schema, `events` or `drizzle` in SQL (`houses.houses` inside bookings fails; the event type
`houses.v1.HouseDeletedEvent` does not).

## Column conventions

| Data                                 | Column                                                                                                 | Notes                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| id                                   | `uuid('id').primaryKey()`                                                                              | value from `IdGenerator` (UUIDv7); no DB default          |
| reference to another module's entity | `uuid('owner_id').notNull()` + index                                                                   | a plain id: no foreign key across schemas                 |
| text                                 | `text(...)`                                                                                            | lengths are enforced in the domain                        |
| money                                | `bigint('x_minor', { mode: 'number' })` + `char('currency_code', { length: 3 })`                       | integer minor units                                       |
| timestamp                            | `timestamp('created_at', { withTimezone: true, precision: 3 })`                                        | ms precision round-trips with JS Date                     |
| calendar date                        | `date('check_in', { mode: 'string' })`                                                                 | 'YYYY-MM-DD' strings, no time zone bugs                   |
| enum-like status                     | `text('status', { enum: [...] })` + `check(...)`                                                       | adding a value is a migration (see zero-downtime)         |
| set of enum-like values (roles)      | `text('roles').array().notNull()` + `check('users_roles_check', sql\`... <@ ARRAY['admin']::text[]\`)` | every element must be known; adding a role is a migration |
| small bounded integer (guests)       | `integer(...)` + `check('bookings_guests_check', sql\`... > 0\`)`                                      |                                                           |

A column compared with `now()` in SQL keeps full precision (`timestamp(..., { withTimezone:
true })` without `precision`), as the platform's `events.deliveries.available_at` does: a
value rounded to milliseconds can land after the `now()` of the transaction looking for it.

Ranges of numbers and enum-like values also get a `CHECK` constraint (cheap, and it
protects data written by future code paths); text lengths are enforced in the domain only.
Name constraints explicitly (`unique('users_email_key')`, `check('bookings_dates_check',
...)`): the names are how `translateDbError` maps violations to domain errors. Foreign keys
inside one module's schema are fine (`users.identities.user_id` references `users.users`
with `onDelete: 'cascade'`).

Scope uniqueness to what the caller may know: the template's names are unique per owner
(`unique('sample_items_owner_id_name_key').on(table.ownerId, table.name)`), because a global
key would tell users which names other users have.

## Invariants belong in constraints

A check-then-insert in code is a race: two requests both see "free" and both insert. Let
Postgres decide atomically and translate the violation:

```ts
try {
  await this.db.tx.insert(users).values(row);
} catch (error) {
  throw translateDbError(error, { users_email_key: () => userEmailTaken(user.email) });
}
```

`translateDbError` (from `@gam/platform`) also maps serialization failures and deadlocks to
`ConcurrencyError` (409 `TRANSACTION_CONFLICT`) and statement timeouts to
`DependencyUnavailableError` (503 `DATABASE_TIMEOUT`); anything unmapped is returned as is
and becomes 500. You only need it for named constraints: the `ProblemDetailsFilter` applies
the same mappings to every error that reaches it (a read, `SELECT ... FOR UPDATE`, the
commit). Bookings shows the strongest form: an exclusion constraint
(`EXCLUDE USING gist (house_id WITH =, daterange(check_in, check_out, '[)') WITH &&) WHERE
(status = 'CONFIRMED')`, named `bookings_no_overlap`) makes double booking impossible under
any concurrency; the repository maps it to `BOOKING_DATES_UNAVAILABLE`.

## Repositories

```ts
@Injectable()
export class DrizzleHouseRepository extends HouseRepository {
  constructor(private readonly db: DbContext) {
    super();
  } // value import of DbContext!

  async findById(id: string, options: { forUpdate?: boolean } = {}) {
    const query = this.db.tx.select().from(houses).where(eq(houses.id, id));
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async list(filter: HouseFilter, { limit, after }: PageRequest) {
    const rows = await this.db.tx
      .select()
      .from(houses)
      .where(
        and(
          after ? lt(houses.id, after) : undefined,
          filter.ownerId ? eq(houses.ownerId, filter.ownerId) : undefined,
        ),
      )
      .orderBy(desc(houses.id))
      .limit(limit + 1); // one extra row tells toPage() there is a next page
    return toPage(rows.map(toDomain), limit);
  }
}
```

- `this.db.tx` is the current transaction inside `UnitOfWork.run()`, otherwise the root
  database. A nested `run()` joins the outer transaction (no savepoint), so an inner
  failure rolls back everything. `DbContext.inTransaction()` tells whether one is open.
- Map rows to aggregates with `X.restore(...)` and back with `toState()`; the repository is
  the only place that knows both shapes.
- Use the core query builder (`select/insert/update/delete`), not the relational query API:
  the core builder is the stable part of Drizzle 1.0 RC.
- Keyset pagination works because UUIDv7 ids sort by creation time. A filtered list needs a
  composite `(filter, id)` index (`houses_owner_id_id_idx`; `houses_city_lower_id_idx` on
  `lower(city), id` for the case-insensitive filter).
- Lists of private data take the domain's typed scope as a required parameter
  (`list(scope: BookingScope, filter, page)`) and turn each kind into its WHERE clause
  (`guest` -> `guest_id = $1`, `host` -> `host_id = $1`, `all` -> none), each backed by a
  `(column, id)` index (`bookings_guest_id_id_idx`, `bookings_host_id_id_idx`).
- Return `boolean` from deletes (`.returning({ id })`), and let the use case raise its
  not-found error. Bulk cleanups return what they removed (`deleteByOwner` returns the
  houses, so the use case can announce each one).

## Migrations

```bash
pnpm --filter @gam/<m> db:generate --name add_house_rating     # diff schema.ts -> SQL
pnpm --filter @gam/<m> db:generate --custom --name no_overlap  # empty file for hand SQL
pnpm --filter @gam/<m> db:generate --explain                   # dry run: print the planned SQL
pnpm --filter @gam/platform db:generate --name <change>        # the events schema (platform only)
pnpm turbo run build --filter=@gam/api... && pnpm db:migrate     # apply with apps/api/.env
pnpm stack:up                                                    # build + migrate with the stack's DATABASE_URL
```

- Read the generated SQL before committing. On an ambiguous rename, drizzle-kit
  (non-interactive) exits with code 2 and prints the `--hints` JSON to pass, so it never
  guesses a drop-and-add.
- Use a custom migration for what drizzle-kit cannot express: exclusion constraints,
  extensions (`CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;`), data
  fixes, triggers. Declare extensions in the module's `modules.json` entry
  (`"extensions": ["btree_gist"]`) so `pnpm db:setup` creates them in `gam` as superuser.
- Never edit or delete a migration that may have run anywhere; add a new one. Never use
  `drizzle-kit push`.
- Each owner has its own history: `runMigrations` passes `migrationsSchema: 'drizzle'` and
  `migrationsTable: '__<name>_migrations'` (dashes become underscores), so the platform's is
  `drizzle.__platform_migrations` and houses' `drizzle.__houses_migrations`.
- `runMigrations({ databaseUrl, sets, lockKey?, lockTimeoutMs? })` takes a session advisory
  lock (`gam:migrations`), so N replicas starting at once apply each migration exactly once,
  and sets `lock_timeout` (default 5000 ms) so a migration stuck behind live traffic fails
  instead of blocking it. Sets apply in order (the platform first); each set's pending
  migrations run in one transaction, so a failing set rolls back alone, earlier sets stay
  applied, and the error names it (`migrations of <name> failed: ...`). Run it as a release
  step (`node dist/migrate.js` with the app's image), never from `main.ts`.
- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction: big-table indexes are a
  manual release step before the migration that declares them with `IF NOT EXISTS`.

### Adding a required column to a populated table

A generated `ADD COLUMN ... NOT NULL` without a default fails on any table that has rows,
and a made-up default hides missing data. Go **expand -> backfill -> contract**: add the
column nullable (code writes it from then on), backfill old rows with a batched one-off job
outside the migrator, then `SET NOT NULL` in a later migration. Recipes and lock details:
`references/zero-downtime.md`.

## Configuration and pooling

`DATABASE_URL`, `DB_POOL_MAX` (default 10) and `DB_STATEMENT_TIMEOUT_MS` (default 1500) are
part of `platformConfigSchema`. One pool per process serves every module (its
`application_name` is the app's name); idle transactions are cut after twice the
statement timeout. Keep the statement timeout short, so a slow query or a lock wait ends as
503 `DATABASE_TIMEOUT` instead of holding a connection until the request's own deadline
(`REQUEST_TIMEOUT_MS`, 30 s). Budget connections: replicas x `DB_POOL_MAX` must stay below
the server's `max_connections`; beyond that put PgBouncer in front and keep migrations on a
direct connection. `/readyz` reports `database: "unavailable"` when `select 1` fails.

## The events schema belongs to the platform (ADR-0005)

Unlike global-architecture, modules do not copy outbox or `processed_events` tables: the
platform owns `events.events` (every published event: type, producer, aggregate id, occur
time, `jsonb` payload up to 64 KiB, request id, traceparent) and `events.deliveries` (one
row per subscribing module and event: `pending`, `delivered` or `dead`, attempts,
`available_at`, `last_error`). `PLATFORM_MIGRATIONS` creates them before any module's
migrations. Only the kit touches them: `Outbox.add` writes both in the module's transaction,
the `EventDispatcher` delivers, `EventsAdmin` serves the `events:*` commands, and the test
helpers read them. Module code never queries them (check-boundaries refuses `events.` in a
module's SQL). For lag at a glance, run `pnpm events:status`, or as an operator in `psql`:

```sql
select subscriber, type, status, count(*), min(available_at) from events.deliveries group by 1, 2, 3;
```

## Tests

Integration tests get a database of their own (`gam_t_<random>`, created from
`TEST_DATABASE_URL`, default `postgresql://gam:gam@localhost:5432/gam_test`) with the
migration sets you pass: `createTestDatabase({ migrations: [PLATFORM_MIGRATIONS,
HOUSES_MIGRATIONS] })` from `@gam/platform/testing`. `truncate('houses.houses',
'events.events')` empties tables between tests (`schema.table` only, with cascade) and
`dispose()` drops the database. Never point tests at `gam`. Details: `gam-testing`.
