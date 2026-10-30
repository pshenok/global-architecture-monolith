import {
  type Actor,
  adminRoleRequired,
  Clock,
  ConflictError,
  type IdentityActor,
  IdGenerator,
  isAdmin,
  type Page,
  type PageRequest,
  type Role,
  UnitOfWork,
  type UserActor,
} from '@gam/kernel';
import { Injectable } from '@nestjs/common';
import { userAlreadyRegistered, userNotFound } from '../domain/user.errors.ts';
import { UserRepository } from '../domain/user.repository.ts';
import { User, type UserChanges } from '../domain/user.ts';
import { UserEvents } from './ports/user-events.ts';

/** Use cases of the users module. */
@Injectable()
export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
    private readonly events: UserEvents,
  ) {}

  /**
   * Registers the calling identity as a new user, with the email the API accepted from
   * the identity provider. Uniqueness of email and identity is enforced by
   * constraints; when two registrations race, the loser learns which one it lost.
   */
  async register(actor: IdentityActor, input: { fullName: string }): Promise<User> {
    const now = this.clock.now();
    const user = User.create(
      { id: this.ids.newId(), email: actor.email, fullName: input.fullName },
      now,
    );
    const identity = { issuer: actor.issuer, subject: actor.subject };
    try {
      await this.unitOfWork.run(async () => {
        await this.users.insert(user);
        await this.users.linkIdentity(user.id, identity, now);
      });
    } catch (error) {
      // A concurrent registration of the same identity commits its user first, so this
      // one fails on the email. Report what really happened: the identity is taken.
      if (
        error instanceof ConflictError &&
        error.reason === 'USER_EMAIL_TAKEN' &&
        (await this.users.findByIdentity(identity))
      ) {
        throw userAlreadyRegistered();
      }
      throw error;
    }
    return user;
  }

  /** The user and roles of a login, or null when it has not registered. */
  async resolve(actor: IdentityActor): Promise<{ userId: string; roles: readonly Role[] } | null> {
    const user = await this.users.findByIdentity({ issuer: actor.issuer, subject: actor.subject });
    return user ? { userId: user.id, roles: user.roles } : null;
  }

  /** Users see themselves, admins see everyone; to anyone else a user does not exist. */
  async get(actor: Actor, id: string): Promise<User> {
    const user = await this.users.findById(id);
    if (!user?.isVisibleTo(actor)) throw userNotFound(id);
    return user;
  }

  async list(actor: UserActor, page: PageRequest): Promise<Page<User>> {
    if (!isAdmin(actor)) throw adminRoleRequired();
    return this.users.list(page);
  }

  /** Read-modify-write under a row lock, so concurrent partial updates never lose each other's changes. */
  update(actor: UserActor, id: string, changes: UserChanges): Promise<User> {
    return this.unitOfWork.run(async () => {
      const user = await this.users.findById(id, { forUpdate: true });
      if (!user?.isVisibleTo(actor)) throw userNotFound(id);
      user.update(changes, this.clock.now());
      await this.users.update(user);
      return user;
    });
  }

  /**
   * Deletes the account and its logins, and records UserDeletedEvent in the same
   * transaction: other modules clean up its houses and bookings asynchronously (ADR-0005).
   */
  delete(actor: UserActor, id: string): Promise<void> {
    return this.unitOfWork.run(async () => {
      const user = await this.users.findById(id, { forUpdate: true });
      if (!user?.isVisibleTo(actor)) throw userNotFound(id);
      await this.users.delete(id);
      await this.events.deleted(id);
    });
  }
}
