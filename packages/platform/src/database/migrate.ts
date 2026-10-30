import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * The migrations of one owner: the platform (its `events` schema) or a module (its own
 * schema). Each owner keeps its history in its own table, `drizzle.__<name>_migrations`,
 * so modules evolve independently and one can later move to a database of its own.
 */
export interface MigrationSet {
  /** `platform` or the module name (kebab-case). */
  readonly name: string;
  /** Folder produced by `drizzle-kit generate`. */
  readonly folder: string;
}

const NAME = /^[a-z][a-z0-9-]*[a-z0-9]$/;

/** A migration set from a folder URL, e.g. `migrationSet('houses', new URL('../drizzle', import.meta.url))`. */
export function migrationSet(name: string, folder: URL): MigrationSet {
  if (!NAME.test(name)) throw new TypeError(`migration set name must be kebab-case, got "${name}"`);
  return Object.freeze({ name, folder: fileURLToPath(folder) });
}

export interface RunMigrationsOptions {
  readonly databaseUrl: string;
  /** Applied in this order: the platform first, then the modules. */
  readonly sets: readonly MigrationSet[];
  /** Advisory-lock key; default `gam`. */
  readonly lockKey?: string;
  /**
   * Max wait for a table/row lock inside a migration (default 5000 ms). A migration that
   * queues behind live traffic fails fast instead of blocking every query behind it.
   * It does not limit waiting for the migration advisory lock itself.
   */
  readonly lockTimeoutMs?: number;
}

/**
 * Applies pending Drizzle migrations of every set. Safe when N replicas start at once: a
 * session-level advisory lock serialises migrators (Drizzle's own migrator takes no lock
 * and concurrent runs crash). Run it as a release step, not in main.ts.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  const names = options.sets.map((set) => set.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`migration sets must have distinct names, got ${names.join(', ')}`);
  }
  const key = `${options.lockKey ?? 'gam'}:migrations`;
  // Dedicated session for the advisory lock: no lock_timeout, replicas wait their turn.
  const lockClient = new pg.Client({
    connectionString: options.databaseUrl,
    application_name: `${options.lockKey ?? 'gam'}:migrator-lock`,
  });
  await lockClient.connect();
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    max: 1,
    application_name: `${options.lockKey ?? 'gam'}:migrator`,
    lock_timeout: options.lockTimeoutMs ?? 5_000,
  });
  try {
    await lockClient.query('select pg_advisory_lock(hashtext($1))', [key]);
    const db = drizzle({ client: pool });
    for (const set of options.sets) {
      try {
        await migrate(db, {
          migrationsFolder: set.folder,
          migrationsSchema: 'drizzle',
          migrationsTable: `__${set.name.replaceAll('-', '_')}_migrations`,
        });
      } catch (error) {
        throw new Error(`migrations of ${set.name} failed: ${String(error)}`, { cause: error });
      }
    }
  } finally {
    await lockClient.query('select pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined);
    await lockClient.end();
    await pool.end();
  }
}
