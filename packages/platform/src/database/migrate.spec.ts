import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.ts';
import { type MigrationSet, runMigrations } from './migrate.ts';

function folderWith(sql: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'gam-migrations-'));
  const migration = join(folder, '20260101000000_init');
  mkdirSync(migration);
  writeFileSync(join(migration, 'migration.sql'), sql);
  writeFileSync(join(migration, 'snapshot.json'), '{}');
  return folder;
}

/** Real Postgres: concurrent migrators apply each set exactly once, each in its own history. */
describe('runMigrations', () => {
  let db: TestDatabase;
  const sets: MigrationSet[] = [];

  beforeAll(async () => {
    db = await createTestDatabase({ migrations: [] });
    sets.push(
      {
        name: 'alpha',
        folder: folderWith('create schema alpha; create table alpha.widgets (id int primary key);'),
      },
      {
        name: 'beta-two',
        folder: folderWith('create schema beta; create table beta.gadgets (id int primary key);'),
      },
    );
  });

  afterAll(async () => {
    await db.dispose();
    for (const set of sets) rmSync(set.folder, { recursive: true, force: true });
  });

  it('serializes concurrent runs with the advisory lock', async () => {
    await Promise.all(
      Array.from({ length: 4 }, () => runMigrations({ databaseUrl: db.url, sets })),
    );
    for (const table of ['__alpha_migrations', '__beta_two_migrations']) {
      const applied = await db.pool.query(`select count(*)::int as n from drizzle."${table}"`);
      expect(applied.rows[0].n).toBe(1);
    }
    const tables = await db.pool.query(
      `select table_schema || '.' || table_name as name from information_schema.tables
       where table_schema in ('alpha', 'beta') order by 1`,
    );
    expect(tables.rows.map((row) => row.name)).toEqual(['alpha.widgets', 'beta.gadgets']);
  });

  it('refuses two sets with one name, and names the set whose migration fails', async () => {
    await expect(
      runMigrations({
        databaseUrl: db.url,
        sets: [sets[0] as MigrationSet, sets[0] as MigrationSet],
      }),
    ).rejects.toThrow(/distinct names/);
    const broken = { name: 'broken', folder: folderWith('create table nope (;') };
    sets.push(broken);
    await expect(runMigrations({ databaseUrl: db.url, sets: [broken] })).rejects.toThrow(
      /migrations of broken failed/,
    );
  });
});
