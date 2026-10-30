import type { UserActor } from '@gam/kernel';

/** What the bookings module needs to know about users. */
export abstract class UserDirectory {
  /**
   * Whether the acting user still exists (it may have been deleted since the request was
   * authenticated). The users module answers as that user, so this cannot ask about
   * anyone else.
   */
  abstract stillExists(actor: UserActor): Promise<boolean>;
}
