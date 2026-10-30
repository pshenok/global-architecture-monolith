import type { UserActor } from '@gam/kernel';
import { UsersApi } from '@gam/users';
import { Injectable } from '@nestjs/common';
import { UserDirectory } from '../../application/ports/user-directory.ts';

/** UserDirectory backed by the users module's public API (in process). */
@Injectable()
export class UsersApiDirectory extends UserDirectory {
  constructor(private readonly users: UsersApi) {
    super();
  }

  stillExists(actor: UserActor): Promise<boolean> {
    return this.users.stillExists(actor);
  }
}
