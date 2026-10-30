import { userInfo } from 'node:os';
import type { Role } from '@gam/kernel';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { User } from '../domain/user.ts';
import { users } from '../infrastructure/persistence/schema.ts';

export interface RoleChange {
  readonly action: 'grant' | 'revoke';
  readonly userId: string;
  readonly role: string;
  /** Who asked for the change (`--by`), if given. */
  readonly by?: string;
}

/** Parses `grant|revoke <userId> <role> [--by <name>]`; undefined when malformed. */
export function parseRoleChange(args: readonly string[]): RoleChange | undefined {
  const [action, userId, role, ...rest] = args;
  if ((action !== 'grant' && action !== 'revoke') || !userId || !role) return undefined;
  if (rest.length === 0) return { action, userId, role };
  const [flag, by, ...extra] = rest;
  if (flag !== '--by' || !by?.trim() || extra.length > 0) return undefined;
  return { action, userId, role, by: by.trim() };
}

/**
 * Who made a change, for the line the CLI prints: `--by`, else the OS user this process
 * runs as (inside a container that is the image's user, so pass `--by` there). Never
 * throws: a uid without a passwd entry (an arbitrary runAsUser) prints as `uid <n>`.
 */
export function changedBy(by: string | undefined, osUser = () => userInfo().username): string {
  if (by) return by;
  try {
    return osUser();
  } catch {
    return `uid ${process.getuid?.() ?? 'unknown'}`;
  }
}

/** Applies the change in one transaction, the user's row locked; returns the roles after it. */
export async function changeRole(db: NodePgDatabase, change: RoleChange): Promise<readonly Role[]> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(users).where(eq(users.id, change.userId)).for('update');
    if (!row) throw new Error(`user ${change.userId} not found`);
    const user = User.restore({ ...row, roles: row.roles as Role[] });
    if (change.action === 'grant') user.grantRole(change.role, new Date());
    else user.revokeRole(change.role, new Date());
    const state = user.toState();
    await tx
      .update(users)
      .set({ roles: [...state.roles], updatedAt: state.updatedAt })
      .where(eq(users.id, change.userId));
    return state.roles;
  });
}
