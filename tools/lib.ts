import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const REGISTRY_PATH = `${ROOT}modules.json`;

export interface ModuleEntry {
  /** e.g. `houses`: the Nest module's event and subscriber name. */
  name: string;
  /** e.g. `modules/houses` */
  dir: string;
  /** e.g. `@gam/houses` */
  package: string;
  /** The Postgres schema the module owns, e.g. `houses`. */
  schema: string;
  /** Postgres extensions its migrations need (pre-created by `pnpm db:setup`), e.g. `btree_gist`. */
  extensions?: string[];
}

export interface Registry {
  $comment: string;
  api: { name: string; dir: string; package: string; httpsPort: number; database: string };
  /** Local OIDC provider of the stack (tools/dev-idp.ts). */
  devIdp: { port: number };
  /** The database the role may create per-test databases from. */
  testDatabase: string;
  modules: ModuleEntry[];
}

export function readRegistry(): Registry {
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
}

export function writeRegistry(registry: Registry): void {
  writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
}

/** The role every local database belongs to (see db:setup). */
export const LOCAL_ROLE = 'gam';

/** Connection URL the local stack uses for a database (role gam, see db:setup). */
export function databaseUrl(database: string): string {
  return `postgresql://${LOCAL_ROLE}:${LOCAL_ROLE}@localhost:5432/${database}`;
}

export const DEFAULT_PG_ADMIN_URL = `postgresql://${process.env.USER ?? 'postgres'}@localhost:5432/postgres`;

/** Local secrets and certificates (git-ignored). */
export const CERTS_DIR = `${ROOT}.certs`;
