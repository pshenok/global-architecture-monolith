import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The users module's own Postgres schema (source of truth for `pnpm db:generate`). No
 * other module reads or writes it: they ask UsersApi, or react to its events.
 */
export const usersSchema = pgSchema('users');

export const users = usersSchema.table(
  'users',
  {
    id: uuid('id').primaryKey(),
    /** Null when the identity provider shares no email (NULLs never collide in the unique key). */
    email: text('email'),
    fullName: text('full_name').notNull(),
    /** Platform roles; the check constraint lists every role this version knows. */
    roles: text('roles').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [
    unique('users_email_key').on(table.email),
    check('users_roles_check', sql`${table.roles} <@ ARRAY['admin']::text[]`),
  ],
);

/** Identity-provider logins of a user: (issuer, subject) is unique across the platform. */
export const identities = usersSchema.table(
  'identities',
  {
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [
    primaryKey({ name: 'identities_pkey', columns: [table.issuer, table.subject] }),
    index('identities_user_id_idx').on(table.userId),
  ],
);

export type UserRow = typeof users.$inferSelect;
