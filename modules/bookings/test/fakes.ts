import {
  Clock,
  IdGenerator,
  type Page,
  type PageRequest,
  toPage,
  UnitOfWork,
  type UserActor,
} from '@gam/kernel';
import { HouseCatalog } from '../src/application/ports/house-catalog.ts';
import { UserDirectory } from '../src/application/ports/user-directory.ts';
import { datesUnavailable } from '../src/domain/booking.errors.ts';
import { type BookingFilter, BookingRepository } from '../src/domain/booking.repository.ts';
import { Booking, type BookingState, type HouseTerms } from '../src/domain/booking.ts';
import type { BookingScope } from '../src/domain/booking-scope.ts';

export const GUEST_ID = '01900000-0000-7000-8000-0000000000a1';
export const HOST_ID = '01900000-0000-7000-8000-0000000000c1';
export const STRANGER_ID = '01900000-0000-7000-8000-0000000000d1';
export const HOUSE_ID = '01900000-0000-7000-8000-0000000000b1';
export const OTHER_HOUSE = '01900000-0000-7000-8000-0000000000b2';
export const TERMS: HouseTerms = {
  maxGuests: 4,
  nightlyPrice: { currencyCode: 'USD', amountMinor: 10_000 },
  ownerId: HOST_ID,
};

/** "YYYY-MM-DD" n days after `from` (UTC). */
export function day(n: number, from = new Date()): string {
  const base = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return new Date(base + n * 86_400_000).toISOString().slice(0, 10);
}

export class SequentialIds extends IdGenerator {
  private next = 0;

  newId(): string {
    this.next += 1;
    return `01900000-0000-7000-8000-${String(this.next).padStart(12, '0')}`;
  }
}

export class FixedClock extends Clock {
  constructor(public current = new Date('2026-06-01T12:00:00.000Z')) {
    super();
  }

  now(): Date {
    return this.current;
  }
}

export class PassThroughUnitOfWork extends UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}

export class FakeUserDirectory extends UserDirectory {
  constructor(public readonly known = new Set<string>([GUEST_ID])) {
    super();
  }

  async stillExists(actor: UserActor): Promise<boolean> {
    return this.known.has(actor.userId);
  }
}

export class FakeHouseCatalog extends HouseCatalog {
  constructor(public readonly houses = new Map<string, HouseTerms>([[HOUSE_ID, TERMS]])) {
    super();
  }

  async findTerms(houseId: string): Promise<HouseTerms | null> {
    return this.houses.get(houseId) ?? null;
  }
}

/** Same contract as the Drizzle adapter, including the no-overlap rule. */
export class InMemoryBookingRepository extends BookingRepository {
  readonly rows = new Map<string, BookingState>();

  async findById(id: string): Promise<Booking | null> {
    const state = this.rows.get(id);
    return state ? Booking.restore(state) : null;
  }

  async list(
    scope: BookingScope,
    filter: BookingFilter,
    { limit, after }: PageRequest,
  ): Promise<Page<Booking>> {
    const rows = [...this.rows.values()]
      .filter((s) => scope.kind !== 'guest' || s.guestId === scope.userId)
      .filter((s) => scope.kind !== 'host' || s.hostId === scope.userId)
      .filter((s) => after === null || s.id < after)
      .filter((s) => !filter.houseId || s.houseId === filter.houseId)
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit + 1)
      .map((s) => Booking.restore(s));
    return toPage(rows, limit);
  }

  async insert(booking: Booking): Promise<void> {
    const next = booking.toState();
    for (const s of this.rows.values()) {
      const overlaps =
        s.houseId === next.houseId && s.checkIn < next.checkOut && next.checkIn < s.checkOut;
      if (overlaps && s.status === 'CONFIRMED') throw datesUnavailable(next.houseId);
    }
    this.rows.set(next.id, next);
  }

  async update(booking: Booking): Promise<void> {
    this.rows.set(booking.id, booking.toState());
  }

  async cancelOpenStays(
    of: { readonly houseId: string } | { readonly guestId: string },
    cutoff: string,
    at: Date,
  ): Promise<number> {
    let cancelled = 0;
    for (const state of this.rows.values()) {
      const matches = 'houseId' in of ? state.houseId === of.houseId : state.guestId === of.guestId;
      if (!matches || state.status !== 'CONFIRMED' || state.checkOut <= cutoff) continue;
      this.rows.set(state.id, { ...state, status: 'CANCELLED', cancelledAt: at, updatedAt: at });
      cancelled += 1;
    }
    return cancelled;
  }
}
