import { type Page, type PageRequest, toPage } from '@gam/kernel';
import { DbContext, translateDbError } from '@gam/platform';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import { datesUnavailable } from '../../domain/booking.errors.ts';
import { type BookingFilter, BookingRepository } from '../../domain/booking.repository.ts';
import { Booking } from '../../domain/booking.ts';
import type { BookingScope } from '../../domain/booking-scope.ts';
import { type BookingRow, bookings, NO_OVERLAP_CONSTRAINT } from './schema.ts';

const toDomain = (row: BookingRow): Booking =>
  Booking.restore({
    id: row.id,
    houseId: row.houseId,
    guestId: row.guestId,
    hostId: row.hostId,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    guests: row.guests,
    totalPrice: { currencyCode: row.currencyCode, amountMinor: row.totalPriceMinor },
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cancelledAt: row.cancelledAt,
  });

const toRow = (booking: Booking): BookingRow => {
  const { totalPrice, ...state } = booking.toState();
  return {
    ...state,
    totalPriceMinor: totalPrice.amountMinor,
    currencyCode: totalPrice.currencyCode,
  };
};

/** Drizzle adapter of the BookingRepository port. */
@Injectable()
export class DrizzleBookingRepository extends BookingRepository {
  constructor(private readonly db: DbContext) {
    super();
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<Booking | null> {
    const query = this.db.tx.select().from(bookings).where(eq(bookings.id, id));
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async list(
    scope: BookingScope,
    filter: BookingFilter,
    { limit, after }: PageRequest,
  ): Promise<Page<Booking>> {
    const rows = await this.db.tx
      .select()
      .from(bookings)
      .where(
        and(
          scope.kind === 'guest' ? eq(bookings.guestId, scope.userId) : undefined,
          scope.kind === 'host' ? eq(bookings.hostId, scope.userId) : undefined,
          after ? lt(bookings.id, after) : undefined,
          filter.houseId ? eq(bookings.houseId, filter.houseId) : undefined,
        ),
      )
      .orderBy(desc(bookings.id))
      .limit(limit + 1);
    return toPage(rows.map(toDomain), limit);
  }

  async insert(booking: Booking): Promise<void> {
    const row = toRow(booking);
    try {
      await this.db.tx.insert(bookings).values(row);
    } catch (error) {
      throw translateDbError(error, {
        [NO_OVERLAP_CONSTRAINT]: () => datesUnavailable(row.houseId),
      });
    }
  }

  async update(booking: Booking): Promise<void> {
    const { id, ...row } = toRow(booking);
    await this.db.tx.update(bookings).set(row).where(eq(bookings.id, id));
  }

  /** One statement on bookings_house_id_id_idx or bookings_guest_id_id_idx. */
  async cancelOpenStays(
    of: { readonly houseId: string } | { readonly guestId: string },
    cutoff: string,
    at: Date,
  ): Promise<number> {
    const rows = await this.db.tx
      .update(bookings)
      .set({ status: 'CANCELLED', cancelledAt: at, updatedAt: at })
      .where(
        and(
          'houseId' in of ? eq(bookings.houseId, of.houseId) : eq(bookings.guestId, of.guestId),
          eq(bookings.status, 'CONFIRMED'),
          gt(bookings.checkOut, cutoff),
        ),
      )
      .returning({ id: bookings.id });
    return rows.length;
  }
}
