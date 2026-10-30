import { describe, expect, it } from 'vitest';
import { ANONYMOUS, adminRoleRequired, isAdmin, type UserActor } from './actor.ts';
import { PermissionDeniedError } from './errors.ts';
import { adminActor, identityActor, serviceActor, userActor } from './testing.ts';

describe('actors', () => {
  it('recognises admins only among users', () => {
    expect(isAdmin(adminActor('u1'))).toBe(true);
    expect(isAdmin(userActor('u1'))).toBe(false);
    expect(isAdmin(serviceActor('bookings'))).toBe(false);
    expect(isAdmin(identityActor('https://idp', 'sub-1'))).toBe(false);
    expect(isAdmin(ANONYMOUS)).toBe(false);
  });

  it('cannot be forged with an object literal', () => {
    // @ts-expect-error UserActor is branded: only the platform kit creates one from a verified token
    const forged: UserActor = { kind: 'user', userId: 'u1', roles: [] };
    expect(forged.kind).toBe('user');
  });

  it('freezes test actors', () => {
    const actor = userActor('u1', ['admin']);
    expect(Object.isFrozen(actor)).toBe(true);
    expect(Object.isFrozen(actor.roles)).toBe(true);
  });

  it('reports a missing admin role as PERMISSION_DENIED', () => {
    const error = adminRoleRequired();
    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(error.reason).toBe('ADMIN_ROLE_REQUIRED');
  });
});
