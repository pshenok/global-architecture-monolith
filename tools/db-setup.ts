/**
 * Creates the local Postgres role and the app's database, plus the test database the
 * test suites create their per-file databases from. Idempotent. Needs a superuser
 * connection:
 *   PG_ADMIN_URL (default postgresql://$USER@localhost:5432/postgres)
 *
 * The role `gam` may create databases (each test file makes and drops its own,
 * `gam_t_<random>`); it owns only what it creates.
 *
 *   pnpm db:setup --reset gam [gam_test] --yes [--adopt]
 *     drops and recreates the named databases first (dev data only). Refused in
 *     production and for a Postgres that is not local (loopback or a Unix socket). It
 *     drops only a database db:setup created: one with its comment marker, or, with
 *     --adopt, one owned by `gam` without a comment. A database created any other way is
 *     never dropped. The marker cannot tell a shared server behind a localhost tunnel from
 *     your own: never reset through one.
 */
import { isIPv4 } from 'node:net';
import pg from 'pg';
import { ensureEnvFiles } from './env-files.ts';
import { DEFAULT_PG_ADMIN_URL, LOCAL_ROLE, readRegistry } from './lib.ts';

/** Written on every database db:setup creates; --reset drops only databases that carry it. */
const LOCAL_MARKER = 'global-architecture-monolith local stack (pnpm db:setup)';

for (const file of ensureEnvFiles()) console.log(`created ${file} from .env.example`);

const adminUrl = process.env.PG_ADMIN_URL ?? DEFAULT_PG_ADMIN_URL;
if (!URL.canParse(adminUrl)) {
  throw new Error(
    'PG_ADMIN_URL is not a URL (for a Unix socket: postgresql:///postgres?host=/path)',
  );
}
const registry = readRegistry();
const databases = [registry.api.database, registry.testDatabase];
const args = process.argv.slice(2);
const toReset = args.includes('--reset') ? args.filter((arg) => !arg.startsWith('--')) : [];
const adopt = args.includes('--adopt');

/** The server PG_ADMIN_URL reaches, resolved by node-postgres itself (URL, ?host=, PGHOST). */
const serverHost = (url: string) => new pg.Client({ connectionString: url }).host;
/** A Unix socket, localhost, ::1 or an IPv4 loopback address (not a name like 127.example). */
const isLocal = (host: string) =>
  host.startsWith('/') ||
  host === 'localhost' ||
  host === '::1' ||
  (isIPv4(host) && host.startsWith('127.'));

if (toReset.length > 0) {
  if (process.env.NODE_ENV === 'production') throw new Error('--reset is refused in production');
  if (!args.includes('--yes')) throw new Error(`--reset drops ${toReset.join(', ')}: add --yes`);
  for (const name of toReset) {
    if (!databases.includes(name)) {
      throw new Error(`--reset: ${name} is not a database of this repository`);
    }
  }
  const host = serverHost(adminUrl);
  if (!isLocal(host)) {
    throw new Error(`--reset only drops databases on a local Postgres, not on ${host}`);
  }
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  // Check every database before dropping any of them.
  const { rows: existing } = await client.query<{
    name: string;
    marker: string | null;
    owner: string;
  }>(
    "select datname as name, shobj_description(oid, 'pg_database') as marker, pg_get_userbyid(datdba) as owner from pg_database where datname = any($1)",
    [toReset],
  );
  for (const { name, marker, owner } of existing) {
    if (marker === LOCAL_MARKER) continue;
    const unmarked = marker === null && owner === LOCAL_ROLE;
    if (unmarked && adopt) continue;
    throw new Error(
      unmarked
        ? `--reset: ${name} has no local-stack marker; if it is your own local database, add --adopt`
        : `--reset: ${name} was not created by pnpm db:setup; drop it by hand if it really is disposable`,
    );
  }
  for (const { name } of existing) {
    await client.query(`drop database "${name}" with (force)`);
    console.log(`dropped database ${name}`);
  }
  const role = await client.query('select 1 from pg_roles where rolname = $1', [LOCAL_ROLE]);
  if (role.rowCount === 0) {
    await client.query(`create role ${LOCAL_ROLE} login password '${LOCAL_ROLE}' createdb`);
    console.log(`created role ${LOCAL_ROLE}`);
  }
  for (const name of databases) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`refusing unsafe database name ${name}`);
    const exists = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (exists.rowCount === 0) {
      await client.query(`create database "${name}" owner ${LOCAL_ROLE}`);
      await client.query(`comment on database "${name}" is '${LOCAL_MARKER}'`);
      console.log(`created database ${name}`);
    } else {
      console.log(`database ${name} exists`);
    }
  }
} finally {
  await client.end();
}

// Extensions the modules' migrations create, made here as the superuser too, for a server
// where they are not trusted. (Per-test databases get them from the migrations, as their
// owner: btree_gist is a trusted extension.)
const extensions = new Set(registry.modules.flatMap((module) => module.extensions ?? []));
for (const database of [registry.api.database]) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    for (const extension of extensions) {
      if (!/^[a-z_][a-z0-9_]*$/.test(extension))
        throw new Error(`refusing unsafe extension name ${extension}`);
      await db.query(`create extension if not exists ${extension} with schema public`);
      console.log(`extension ${extension} ready in ${database}`);
    }
  } finally {
    await db.end();
  }
}
