import { adminRoleRequired, isAdmin, type UserActor } from '@gam/kernel';

/** Whose bookings a list returns, from the caller's point of view. */
export type BookingParty = 'guest' | 'host' | 'any';

/** The rows a list may return; repositories filter by it, so no list can forget to scope. */
export type BookingScope =
  | { readonly kind: 'guest'; readonly userId: string }
  | { readonly kind: 'host'; readonly userId: string }
  | { readonly kind: 'all' };

/** Every caller sees its own bookings as guest or host; only admins see all of them. */
export function bookingScopeFor(actor: UserActor, party: BookingParty): BookingScope {
  if (party === 'any') {
    if (!isAdmin(actor)) throw adminRoleRequired();
    return { kind: 'all' };
  }
  return { kind: party, userId: actor.userId };
}
