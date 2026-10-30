import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** The Drizzle database type used by every module (core query builder, no relational API). */
export type Database = NodePgDatabase;

/** DI token of the pg Pool. */
export const PG_POOL = Symbol('PG_POOL');
/** DI token of the root (non-transactional) Drizzle instance. Prefer {@link DbContext}. */
export const DRIZZLE = Symbol('DRIZZLE');
