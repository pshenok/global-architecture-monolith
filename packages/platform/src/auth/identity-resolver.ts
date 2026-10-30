import type { IdentityActor, Role } from '@gam/kernel';

/** The platform user behind a login. */
export interface ResolvedUser {
  readonly userId: string;
  readonly roles: readonly Role[];
}

/**
 * Maps a verified identity-provider login to its platform user. A port of the platform:
 * the module that owns users implements it, and the app binds it in
 * `PlatformModule.forRoot({ identities })`. The AuthGuard calls it on every request that
 * needs a user, so a role change or a deletion applies to the very next request.
 */
export abstract class IdentityResolver {
  /** The user of `identity`, or null when the login has none. */
  abstract resolve(identity: IdentityActor): Promise<ResolvedUser | null>;
}
