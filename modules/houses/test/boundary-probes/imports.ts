/**
 * Self-test of tools/check-boundaries.ts, which reads this file as if it were the houses
 * module's src: every line marked `refused` must be refused, and no other line. Each probe
 * is a way to reach past another module's public API. Nothing imports or runs this file.
 */

import { HousesApi } from '@gam/houses'; // refused
import { UsersApi } from '@gam/users';
import { changeRole } from '@gam/users/ops'; // refused
import { pgSchema, pgTable, pgSchema as schemaOf, text } from 'drizzle-orm/pg-core'; // refused
import { User } from '../../../users/src/domain/user.ts'; // refused
import type { UserRow } from '../../../users/src/infrastructure/persistence/schema.ts'; // refused
import { House } from '../../src/domain/house.ts';

export * from '../../../users/src/contracts/user-events.ts'; // refused
export const lazy = () => import('../../../users/src/ops.ts'); // refused
export type Lazy = import('@gam/users/ops').RoleChange; // refused
export const used: readonly unknown[] = [UsersApi, changeRole, HousesApi, User, House];
export type Row = UserRow;

export const otherTables = pgSchema('users'); // refused
export const ownTablesHere = pgSchema('houses'); // refused
// Refused at its import (a renamed pgSchema): the call itself is not read.
export const renamed = schemaOf('users');
export const publicTable = pgTable('notes', { body: text('body') }); // refused
export const readOthers = 'select * from users.users'; // refused
export const shouting = 'SELECT email FROM USERS.USERS'; // refused
export const spaced = 'select email from users .users'; // refused
export const quotedSpaced = 'select email from "users" . "users"'; // refused
export const quoted = `delete from "users"."identities" where user_id = $1`; // refused
export const platform = 'update events.deliveries set attempts = 0'; // refused
export const eventType = 'users.v1.UserDeletedEvent';
export const own = 'select * from houses.houses';
export const prose = 'the users module keeps its own tables';
