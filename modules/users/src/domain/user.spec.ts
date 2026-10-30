import { ANONYMOUS, ValidationError } from '@gam/kernel';
import { adminActor, userActor } from '@gam/kernel/testing';
import { describe, expect, it } from 'vitest';
import { User } from './user.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-01-02T00:00:00.000Z');

describe('User', () => {
  it('lower-cases the email and trims the name', () => {
    const user = User.create({ id: 'u1', email: '  Ann@Example.COM ', fullName: ' Ann Lee ' }, now);
    expect(user.toState()).toEqual({
      id: 'u1',
      email: 'ann@example.com',
      fullName: 'Ann Lee',
      roles: [],
      createdAt: now,
      updatedAt: now,
    });
  });

  it('allows a user without an email (the identity provider shared none)', () => {
    expect(User.create({ id: 'u1', email: null, fullName: 'Ann' }, now).email).toBeNull();
  });

  it('grants known roles once and refuses unknown ones', () => {
    const user = User.create({ id: 'u1', email: null, fullName: 'Ann' }, now);
    user.grantRole('admin', later);
    user.grantRole('admin', later);
    expect(user.toState()).toMatchObject({ roles: ['admin'], updatedAt: later });
    expect(() => user.grantRole('root', later)).toThrow(ValidationError);
  });

  it('revokes a role it holds, ignores one it does not, and refuses unknown ones', () => {
    const user = User.create({ id: 'u1', email: null, fullName: 'Ann' }, now);
    user.revokeRole('admin', later);
    expect(user.toState()).toMatchObject({ roles: [], updatedAt: now });
    user.grantRole('admin', now);
    user.revokeRole('admin', later);
    expect(user.toState()).toMatchObject({ roles: [], updatedAt: later });
    expect(() => user.revokeRole('root', later)).toThrow(ValidationError);
  });

  it('is visible to the user and to admins only', () => {
    const user = User.create({ id: 'u1', email: null, fullName: 'Ann' }, now);
    expect(user.isVisibleTo(userActor('u1'))).toBe(true);
    expect(user.isVisibleTo(adminActor('u9'))).toBe(true);
    expect(user.isVisibleTo(userActor('u2'))).toBe(false);
    expect(user.isVisibleTo(ANONYMOUS)).toBe(false);
  });

  it('rejects malformed emails and empty names', () => {
    expect(() => User.create({ id: 'u1', email: 'nope', fullName: 'Ann' }, now)).toThrow(
      ValidationError,
    );
    expect(() => User.create({ id: 'u1', email: 'a@b.io', fullName: '  ' }, now)).toThrow(
      ValidationError,
    );
  });

  it('updates the given fields only', () => {
    const user = User.create({ id: 'u1', email: 'a@b.io', fullName: 'Ann' }, now);
    user.update({ fullName: 'Ann Lee' }, later);
    expect(user.toState()).toMatchObject({
      email: 'a@b.io',
      fullName: 'Ann Lee',
      updatedAt: later,
    });
  });

  it('treats an unchanged name as no change', () => {
    const user = User.create({ id: 'u1', email: 'a@b.io', fullName: 'Ann' }, now);
    user.update({ fullName: ' Ann ' }, later);
    expect(user.updatedAt).toEqual(now);
  });
});
