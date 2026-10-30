import type { IdentityActor, Role, ServiceActor, UserActor } from './actor.ts';

/**
 * Actor factories for tests only (`@gam/kernel/testing`). Production code gets actors
 * from the platform kit, which builds them from verified tokens.
 */
export function userActor(userId: string, roles: readonly Role[] = []): UserActor {
  return Object.freeze({ kind: 'user', userId, roles: Object.freeze([...roles]) }) as UserActor;
}

export function adminActor(userId: string): UserActor {
  return userActor(userId, ['admin']);
}

export function identityActor(
  issuer: string,
  subject: string,
  email: string | null = null,
): IdentityActor {
  return Object.freeze({ kind: 'identity', issuer, subject, email }) as IdentityActor;
}

export function serviceActor(name: string): ServiceActor {
  return Object.freeze({ kind: 'service', name }) as ServiceActor;
}
