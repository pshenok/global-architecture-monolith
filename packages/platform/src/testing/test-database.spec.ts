import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, DEFAULT_TEST_DATABASE_URL } from './test-database.ts';

/** Real Postgres: a test database never outlives its test, even when migrations fail. */
describe('createTestDatabase', () => {
  const baseUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 });
  const folders: string[] = [];

  function set(sql: string) {
    const folder = mkdtempSync(join(tmpdir(), 'gam-migrations-'));
    folders.push(folder);
    const migration = join(folder, '20260101000000_init');
    mkdirSync(migration);
    writeFileSync(join(migration, 'migration.sql'), sql);
    writeFileSync(join(migration, 'snapshot.json'), '{}');
    return { name: 'widgets', folder };
  }

  async function databaseExists(name: string): Promise<boolean> {
    const found = await admin.query('select 1 from pg_database where datname = $1', [name]);
    return found.rowCount === 1;
  }

  afterAll(async () => {
    await admin.end();
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  });

  it('applies the migrations, truncates qualified tables and drops the database on dispose', async () => {
    const db = await createTestDatabase({
      migrations: [set('create schema w; create table w.widgets (id int primary key);')],
    });
    expect(await databaseExists(db.name)).toBe(true);
    await db.pool.query('insert into w.widgets values (1)');
    await db.truncate('w.widgets');
    expect((await db.pool.query('select count(*)::int as n from w.widgets')).rows[0].n).toBe(0);
    await expect(db.truncate('widgets; drop table w.widgets')).rejects.toThrow(/schema\.table/);
    await db.dispose();
    expect(await databaseExists(db.name)).toBe(false);
  });

  it('drops the database when migrations fail', async () => {
    const failure = await createTestDatabase({
      migrations: [set('create table widgets (id int primary key;')],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const name = /test database (gam_t_[0-9a-f]{12})/.exec(String(failure))?.[1];
    expect(name).toBeDefined();
    expect(await databaseExists(name ?? '')).toBe(false);
  });
});
