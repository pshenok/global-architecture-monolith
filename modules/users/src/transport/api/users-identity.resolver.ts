import type { IdentityActor } from '@gam/kernel';
import { IdentityResolver, type ResolvedUser } from '@gam/platform';
import { Injectable } from '@nestjs/common';
import { UserService } from '../../application/user.service.ts';

/**
 * The platform's IdentityResolver, answered by the users module: the user and roles of a
 * login, read on every request, so a role change or a deletion applies to the next one.
 * The app binds it in `PlatformModule.forRoot({ identities })`.
 */
@Injectable()
export class UsersIdentityResolver extends IdentityResolver {
  constructor(private readonly users: UserService) {
    super();
  }

  resolve(identity: IdentityActor): Promise<ResolvedUser | null> {
    return this.users.resolve(identity);
  }
}
