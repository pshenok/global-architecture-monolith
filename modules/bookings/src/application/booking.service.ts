import {
  Clock,
  IdGenerator,
  type Page,
  type PageRequest,
  type ServiceActor,
  UnitOfWork,
  type UserActor,
} from '@gam/kernel';
import { Injectable } from '@nestjs/common';
import { bookingNotFound, guestNotFound, houseNotFound } from '../domain/booking.errors.ts';
import { type BookingFilter, BookingRepository } from '../domain/booking.repository.ts';
import { Booking } from '../domain/booking.ts';
import { type BookingParty, bookingScopeFor } from '../domain/booking-scope.ts';
import { nightsOf, openStayCutoff } from '../domain/stay.ts';
import { HouseCatalog } from './ports/house-catalog.ts';
import { UserDirectory } from './ports/user-directory.ts';

export interface CreateBookingInput {
  readonly houseId: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly guests: number;
}

/** Use cases of the bookings module. The acting user is always the first argument. */
@Injectable()
export class BookingService {
  constructor(
    private readonly bookings: BookingRepository,
    private readonly users: UserDirectory,
    private readonly houses: HouseCatalog,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  /**
   * Books a stay for the acting user (the guest).
   * 1. Validate the stay locally (cheap, no query).
   * 2. Ask the users and houses modules in parallel (outside any DB transaction).
   * 3. Insert. The database exclusion constraint rejects overlapping confirmed
   *    bookings atomically, so concurrent requests for the same dates cannot both win.
   */
  async create(actor: UserActor, input: CreateBookingInput): Promise<Booking> {
    const now = this.clock.now();
    nightsOf(input.checkIn, input.checkOut, now);
    const [guestExists, terms] = await Promise.all([
      this.users.stillExists(actor),
      this.houses.findTerms(input.houseId),
    ]);
    if (!guestExists) throw guestNotFound(actor.userId);
    if (!terms) throw houseNotFound(input.houseId);
    const booking = Booking.create(
      { id: this.ids.newId(), guestId: actor.userId, ...input },
      terms,
      now,
    );
    await this.bookings.insert(booking);
    return booking;
  }

  /** Strangers get NOT_FOUND: they must not learn that the booking exists. */
  async get(actor: UserActor, id: string): Promise<Booking> {
    const booking = await this.bookings.findById(id);
    if (!booking?.isVisibleTo(actor)) throw bookingNotFound(id);
    return booking;
  }

  /** async: a scope refusal (non-admin asking for every booking) must reject, not throw. */
  async list(
    actor: UserActor,
    party: BookingParty,
    filter: BookingFilter,
    page: PageRequest,
  ): Promise<Page<Booking>> {
    return this.bookings.list(bookingScopeFor(actor, party), filter, page);
  }

  /**
   * The guest, the host or an admin may cancel. Locks the row so two concurrent
   * cancels resolve to one success and one FAILED_PRECONDITION.
   */
  cancel(actor: UserActor, id: string): Promise<Booking> {
    return this.unitOfWork.run(async () => {
      const booking = await this.bookings.findById(id, { forUpdate: true });
      if (!booking?.isVisibleTo(actor)) throw bookingNotFound(id);
      booking.cancel(this.clock.now());
      await this.bookings.update(booking);
      return booking;
    });
  }

  /**
   * The house is gone (HouseDeletedEvent): cancels its upcoming and ongoing stays and
   * frees their dates; finished stays stay as history. Only the module itself reaches it
   * (handling the event), and running it again changes nothing. Returns how many it
   * cancelled.
   */
  cancelOpenStaysOfHouse(_actor: ServiceActor, houseId: string): Promise<number> {
    return this.cancelOpenStays({ houseId });
  }

  /** The guest's account is gone (UserDeletedEvent): as above, for the guest's stays. */
  cancelOpenStaysOfGuest(_actor: ServiceActor, guestId: string): Promise<number> {
    return this.cancelOpenStays({ guestId });
  }

  private cancelOpenStays(of: { houseId: string } | { guestId: string }): Promise<number> {
    const now = this.clock.now();
    return this.unitOfWork.run(() => this.bookings.cancelOpenStays(of, openStayCutoff(now), now));
  }
}
