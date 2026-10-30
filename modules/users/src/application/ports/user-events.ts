/** Facts about users that other modules react to (ADR-0005). */
export abstract class UserEvents {
  /** Records that a user was deleted; call it inside the deleting UnitOfWork. */
  abstract deleted(userId: string): Promise<void>;
}
