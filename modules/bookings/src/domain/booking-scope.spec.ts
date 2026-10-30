import { PermissionDeniedError } from '@gam/kernel';
import { adminActor, userActor } from '@gam/kernel/testing';
import { describe, expect, it } from 'vitest';
import { bookingScopeFor } from './booking-scope.ts';

describe('bookingScopeFor', () => {
  it('scopes guests and hosts to themselves', () => {
    expect(bookingScopeFor(userActor('u1'), 'guest')).toEqual({ kind: 'guest', userId: 'u1' });
    expect(bookingScopeFor(userActor('u1'), 'host')).toEqual({ kind: 'host', userId: 'u1' });
  });

  it('lets only admins see every booking', () => {
    expect(bookingScopeFor(adminActor('a1'), 'any')).toEqual({ kind: 'all' });
    expect(() => bookingScopeFor(userActor('u1'), 'any')).toThrow(PermissionDeniedError);
  });
});
