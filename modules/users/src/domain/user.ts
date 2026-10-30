import { type Actor, isAdmin, ROLES, type Role, ValidationError } from '@gam/kernel';

/** Persisted state of a User. */
export interface UserState {
  readonly id: string;
  /** Null when the identity provider shared no email. */
  readonly email: string | null;
  readonly fullName: string;
  readonly roles: readonly Role[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What a user may change; the email belongs to the identity provider. */
export interface UserChanges {
  readonly fullName?: string | undefined;
}

export const EMAIL_MAX = 254;
export const FULL_NAME_MAX = 200;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Emails are compared case-insensitively, so they are stored lower-cased. */
function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > EMAIL_MAX || !EMAIL_SHAPE.test(normalized)) {
    throw new ValidationError('email must be a valid address', [
      { field: 'email', description: 'must be a valid email address' },
    ]);
  }
  return normalized;
}

function normalizeFullName(fullName: string): string {
  const trimmed = fullName.trim();
  if (trimmed.length === 0 || trimmed.length > FULL_NAME_MAX) {
    throw new ValidationError(`fullName must be 1..${FULL_NAME_MAX} characters`, [
      { field: 'fullName', description: `must be 1..${FULL_NAME_MAX} characters` },
    ]);
  }
  return trimmed;
}

/** User aggregate: an account on the platform. */
export class User {
  private constructor(private state: UserState) {}

  /**
   * A new user. `email` is what the identity provider vouched for (null when it shared
   * none); it is never taken from what a client typed.
   */
  static create(input: { id: string; email: string | null; fullName: string }, now: Date): User {
    return new User({
      id: input.id,
      email: input.email === null ? null : normalizeEmail(input.email),
      fullName: normalizeFullName(input.fullName),
      roles: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(state: UserState): User {
    return new User({ ...state });
  }

  get id(): string {
    return this.state.id;
  }

  get email(): string | null {
    return this.state.email;
  }

  get roles(): readonly Role[] {
    return this.state.roles;
  }

  get fullName(): string {
    return this.state.fullName;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  /** Applies the given changes; fields left undefined stay as they are. */
  update(changes: UserChanges, now: Date): void {
    const fullName =
      changes.fullName === undefined ? this.state.fullName : normalizeFullName(changes.fullName);
    if (fullName === this.state.fullName) return;
    this.state = { ...this.state, fullName, updatedAt: now };
  }

  /** A user's account is visible to the user and to admins only. */
  isVisibleTo(actor: Actor): boolean {
    return (actor.kind === 'user' && actor.userId === this.state.id) || isAdmin(actor);
  }

  /** Grants a platform role; granting a role the user has is a no-op. */
  grantRole(role: string, now: Date): void {
    const known = knownRole(role);
    if (this.state.roles.includes(known)) return;
    this.state = { ...this.state, roles: [...this.state.roles, known], updatedAt: now };
  }

  /** Revokes a platform role; revoking a role the user does not have is a no-op. */
  revokeRole(role: string, now: Date): void {
    const known = knownRole(role);
    if (!this.state.roles.includes(known)) return;
    this.state = {
      ...this.state,
      roles: this.state.roles.filter((held) => held !== known),
      updatedAt: now,
    };
  }

  toState(): UserState {
    return { ...this.state, roles: [...this.state.roles] };
  }
}

function knownRole(role: string): Role {
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new ValidationError(`unknown role ${role}`, [
      { field: 'role', description: `must be one of ${ROLES.join(', ')}` },
    ]);
  }
  return role as Role;
}
