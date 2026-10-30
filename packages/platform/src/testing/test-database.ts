import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { type MigrationSet, runMigrations } from '../database/migrate.ts';

export interface TestDatabase {
  /** Connection URL of the test database (pass it as DATABASE_URL). */
  readonly url: string;
  readonly name: string;
  readonly pool: pg.Pool;
  /** Empties the given tables (`schema.table`) between tests. */
  truncate(...tables: string[]): Promise<void>;
  /** Drops the database. Call in afterAll. */
  dispose(): Promise<void>;
}

export const DEFAULT_TEST_DATABASE_URL = 'postgresql://gam:gam@localhost:5432/gam_test';

const TABLE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

/**
 * A real Postgres database per test file, with the given migrations applied: modules keep
 * their tables in schemas of their own, so isolation is a whole database. Isolated,
 * parallel-safe and fast, with no Docker needed. Connects to TEST_DATABASE_URL (default
 * gam_test on localhost; `pnpm db:setup` creates it and lets its role create databases).
 */
export async function createTestDatabase(options: {
  readonly migrations: readonly MigrationSet[];
  readonly baseUrl?: string;
}): Promise<TestDatabase> {
  const baseUrl = options.baseUrl ?? process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const name = `gam_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 });
  try {
    await admin.query(`create database "${name}"`);
  } catch (error) {
    await admin.end();
    throw new Error(
      `cannot create a test database from ${new URL(baseUrl).pathname.slice(1)} (run \`pnpm db:setup\`): ${String(error)}`,
    );
  }
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const drop = () => admin.query(`drop database if exists "${name}" with (force)`);
  try {
    await runMigrations({ databaseUrl: url.toString(), sets: options.migrations, lockKey: name });
  } catch (error) {
    // The caller gets no TestDatabase to dispose(), so clean up here.
    await drop().catch(() => undefined);
    await admin.end();
    throw new Error(`migrations failed in test database ${name}: ${String(error)}`, {
      cause: error,
    });
  }
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  return {
    url: url.toString(),
    name,
    pool,
    async truncate(...tables) {
      if (tables.length === 0) return;
      for (const table of tables) {
        if (!TABLE.test(table)) throw new Error(`truncate takes schema.table, got "${table}"`);
      }
      await pool.query(`truncate table ${tables.join(', ')} cascade`);
    },
    async dispose() {
      await pool.end();
      try {
        await drop();
      } finally {
        await admin.end();
      }
    },
  };
}
