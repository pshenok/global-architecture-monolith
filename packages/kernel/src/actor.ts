import { PermissionDeniedError } from './errors.ts';

/**
 * Who is acting on a request, as use cases see it.
 *
 * Use cases take the actor as their first parameter and decide with it (ownership,
 * visibility, roles); they never read it from ambient context. Only the platform kit
 * creates verified actors, from tokens it has checked: the brand below makes an
 * object literal typed as `UserActor` a compile error, so production code cannot
 * invent one from request fields. Tests build actors with `@gam/kernel/testing`.
 */
declare const verified: unique symbol;

interface Verified {
  readonly [verified]: true;
}

/** Platform roles, stored by the users module. An IdP role never becomes a platform role. */
export type Role = 'admin';

export const ROLES: readonly Role[] = Object.freeze(['admin'] as const);

/** A registered platform user (`userId` is the users module's id, never the IdP subject). */
export interface UserActor extends Verified {
  readonly kind: 'user';
  readonly userId: string;
  readonly roles: readonly Role[];
}

/** A verified identity-provider login without a platform user yet (registration only). */
export interface IdentityActor extends Verified {
  readonly kind: 'identity';
  readonly issuer: string;
  readonly subject: string;
  /** Email the API accepted under the issuer's email policy, or null. */
  readonly email: string | null;
}

/** A module acting as itself, not on behalf of a user (event handlers, jobs). */
export interface ServiceActor extends Verified {
  readonly kind: 'service';
  readonly name: string;
}

/** Nobody in particular: the caller of a public operation. */
export interface AnonymousActor {
  readonly kind: 'anonymous';
}

export type Actor = UserActor | IdentityActor | ServiceActor | AnonymousActor;

export const ANONYMOUS: AnonymousActor = Object.freeze({ kind: 'anonymous' });

export function isAdmin(actor: Actor): boolean {
  return actor.kind === 'user' && actor.roles.includes('admin');
}

export const adminRoleRequired = () =>
  new PermissionDeniedError('ADMIN_ROLE_REQUIRED', 'this operation requires the admin role');
