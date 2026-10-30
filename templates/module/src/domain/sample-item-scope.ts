import { isAdmin, type UserActor } from '@gam/kernel';

/** The rows a list may return; the repository filters by it, so no list can forget to scope. */
export type SampleItemScope =
  | { readonly kind: 'owner'; readonly ownerId: string }
  | { readonly kind: 'all' };

/** Users list their own items; admins list everyone's. */
export function sampleItemScopeFor(actor: UserActor): SampleItemScope {
  return isAdmin(actor) ? { kind: 'all' } : { kind: 'owner', ownerId: actor.userId };
}
