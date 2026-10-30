import { type Actor, isAdmin, type Money, multiplyMoney, ValidationError } from '@gam/kernel';
import { bookingAlreadyCancelled, tooManyGuests } from './booking.errors.ts';
import { nightsOf } from './stay.ts';

export type BookingStatus = 'CONFIRMED' | 'CANCELLED';

/** What a booking needs to know about the house at booking time. */
export interface HouseTerms {
  readonly maxGuests: number;
  readonly nightlyPrice: Money;
  /** The house owner; houses never change owner, so the booking keeps it as its host. */
  readonly ownerId: string;
}

/** Persisted state of a Booking. */
export interface BookingState {
  readonly id: string;
  readonly houseId: string;
  readonly guestId: string;
  /** Owner of the house at booking time (snapshot; owners never change). */
  readonly hostId: string;
  /** Inclusive calendar date, "YYYY-MM-DD". */
  readonly checkIn: string;
  /** Exclusive calendar date, "YYYY-MM-DD". */
  readonly checkOut: string;
  readonly guests: number;
  /** nights * nightly price, frozen at booking time. */
  readonly totalPrice: Money;
  readonly status: BookingStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly cancelledAt: Date | null;
}

/**
 * Booking aggregate: a guest's reservation of a house for [checkIn, checkOut).
 * Overlap with other bookings is a cross-aggregate rule, enforced atomically by
 * the database (exclusion constraint), not here.
 */
export class Booking {
  private constructor(private state: BookingState) {}

  static create(
    input: {
      id: string;
      houseId: string;
      guestId: string;
      checkIn: string;
      checkOut: string;
      guests: number;
    },
    house: HouseTerms,
    now: Date,
  ): Booking {
    const nights = nightsOf(input.checkIn, input.checkOut, now);
    if (!Number.isInteger(input.guests) || input.guests < 1) {
      throw new ValidationError('guests must be at least 1', [
        { field: 'guests', description: 'must be at least 1' },
      ]);
    }
    if (input.guests > house.maxGuests) throw tooManyGuests(input.guests, house.maxGuests);
    return new Booking({
      id: input.id,
      houseId: input.houseId,
      guestId: input.guestId,
      hostId: house.ownerId,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests: input.guests,
      totalPrice: multiplyMoney(house.nightlyPrice, nights),
      status: 'CONFIRMED',
      createdAt: now,
      updatedAt: now,
      cancelledAt: null,
    });
  }

  static restore(state: BookingState): Booking {
    return new Booking({ ...state });
  }

  get id(): string {
    return this.state.id;
  }

  get status(): BookingStatus {
    return this.state.status;
  }

  /**
   * The guest, the host and admins may see (and cancel) a booking. Anyone else must
   * not even learn that it exists: callers answer them NOT_FOUND.
   */
  isVisibleTo(actor: Actor): boolean {
    if (isAdmin(actor)) return true;
    return (
      actor.kind === 'user' &&
      (actor.userId === this.state.guestId || actor.userId === this.state.hostId)
    );
  }

  /** Frees the dates. Cancelling twice is a precondition failure, not a no-op. */
  cancel(now: Date): void {
    if (this.state.status === 'CANCELLED') throw bookingAlreadyCancelled(this.state.id);
    this.state = { ...this.state, status: 'CANCELLED', cancelledAt: now, updatedAt: now };
  }

  toState(): BookingState {
    return { ...this.state };
  }
}
