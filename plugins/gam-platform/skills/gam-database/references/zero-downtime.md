# Zero-downtime schema changes (expand, migrate, contract)

During a rolling deploy, instances of the old and the new version of the app run at the
same time against the same database. Every migration must work with both versions. Two
properties of this platform shape the recipes:
- **Drizzle selects every column declared in `schema.ts`** (`db.select().from(t)` names
  them). Old instances break if a column they declare disappears.
- **`runMigrations` applies each owner's pending migrations in one transaction** with
  `lock_timeout` (5000 ms by default, `lockTimeoutMs`). Long backfills or table rewrites
  inside a migration hold locks for the whole run; keep migrations short and do data work
  outside them.

| Change                      | Release 1 (expand)                                                                                                                                                                                               | Release 2 (migrate)                                                      | Release 3 (contract)                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a required column       | add it nullable (or with a constant default); code writes it                                                                                                                                                     | backfill with a one-off job (batched, outside the migrator)              | `SET NOT NULL` in a migration (scans the table under lock: on large tables first add `CHECK (col IS NOT NULL) NOT VALID`, `VALIDATE` it in a later release, then `SET NOT NULL`) |
| Rename a column             | add the new column; code writes both                                                                                                                                                                             | backfill; code reads the new one                                         | remove the old column from `schema.ts` (code stops selecting it) and, in a later release, drop it with a custom migration                                                        |
| Drop a column               | remove it from `schema.ts` but edit the generated migration to **not** drop it yet (old instances still select it)                                                                                               |                                                                          | drop it with a custom migration once no running version declares it                                                                                                              |
| Change a type               | add a new column of the new type, dual-write                                                                                                                                                                     | backfill, switch reads                                                   | as "drop a column" for the old one                                                                                                                                               |
| Add a unique constraint     | clean duplicates                                                                                                                                                                                                 | `CREATE UNIQUE INDEX CONCURRENTLY` as a manual step outside the migrator | `ALTER TABLE ... ADD CONSTRAINT x UNIQUE USING INDEX x` in a migration (Postgres does not support `NOT VALID` for UNIQUE)                                                        |
| Add a check constraint      | clean the data                                                                                                                                                                                                   | add it `NOT VALID`                                                       | `VALIDATE CONSTRAINT` in a later migration                                                                                                                                       |
| Add an index on a big table | `CREATE INDEX CONCURRENTLY IF NOT EXISTS` manually, then declare the index in `schema.ts` (the generated `CREATE INDEX` becomes a no-op only if you edit it to `IF NOT EXISTS`)                                  |                                                                          |                                                                                                                                                                                  |
| Add an enum-like value      | widen the `check` constraint before any code writes the value; drizzle-kit generates DROP + ADD, which re-checks every row under lock, so on large tables add the new constraint `NOT VALID`, then `VALIDATE` it |                                                                          |                                                                                                                                                                                  |

Every table name in these statements is schema-qualified (`"houses"."houses"`): a module
writes only to its own schema.

Rules of thumb:
- Never rename or drop in the same release that stops using a column.
- Backfills are idempotent and batched (`UPDATE ... WHERE id IN (SELECT id ... LIMIT 1000)`),
  run as one-off jobs or scripts, not inside a migration and not in request handling.
- Keep `DB_STATEMENT_TIMEOUT_MS` low for the app; migrations get `lock_timeout` from
  `runMigrations` (`lockTimeoutMs`), so they fail fast instead of blocking production
  traffic.
- Run manual `CONCURRENTLY` steps against the primary directly, never through a
  transaction-mode pooler.
- A module's public API and its event payloads follow the same idea: add, move the callers
  or subscribers, then retire the old shape (see `gam-module-api`).
