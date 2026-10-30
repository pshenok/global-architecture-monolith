import { NotFoundError, type UserActor } from '@gam/kernel';
import { ModuleApi } from '@gam/platform';
import { Injectable } from '@nestjs/common';
import { UserService } from '../../application/user.service.ts';

/**
 * What other modules may ask the users module (its public API, ADR-0002). In-process
 * calls, never inside the caller's transaction (ModuleApi).
 */
@ModuleApi()
@Injectable()
export class UsersApi {
  constructor(private readonly users: UserService) {}

  /**
   * Whether the acting user's account still exists: it may have been deleted since the
   * request was authenticated. Asks as that user, so it cannot ask about anyone else.
   */
  async stillExists(actor: UserActor): Promise<boolean> {
    try {
      await this.users.get(actor, actor.userId);
      return true;
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  }
}
