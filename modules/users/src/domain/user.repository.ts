import type { Page, PageRequest } from '@gam/kernel';
import type { User } from './user.ts';

/** An identity-provider login: issuer URL + subject (the IdP's user id). */
export interface Identity {
  readonly issuer: string;
  readonly subject: string;
}

/**
 * Persistence port for User. The application layer depends on this
 * abstract class (it doubles as the Nest DI token); infrastructure implements it.
 */
export abstract class UserRepository {
  /** `forUpdate` locks the row until the surrounding UnitOfWork ends. */
  abstract findById(id: string, options?: { forUpdate?: boolean }): Promise<User | null>;
  /** Newest first. */
  abstract list(page: PageRequest): Promise<Page<User>>;
  /** Throws a ConflictError when the email is taken. */
  abstract insert(item: User): Promise<void>;
  /** Throws a ConflictError when the email is taken. */
  abstract update(item: User): Promise<void>;
  /** Returns false when nothing was deleted. Deleting a user removes its identities. */
  abstract delete(id: string): Promise<boolean>;
  /** The user an identity belongs to. */
  abstract findByIdentity(identity: Identity): Promise<User | null>;
  /** Throws a ConflictError (USER_ALREADY_REGISTERED) when the identity already has a user. */
  abstract linkIdentity(userId: string, identity: Identity, now: Date): Promise<void>;
}
