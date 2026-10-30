import { MoneyView, pageOf } from '@gam/platform';
import { z } from 'zod';
import type { Booking } from '../../domain/booking.ts';

const calendarDate = z.iso.date().describe('Calendar date YYYY-MM-DD');

/** The guest is the signed-in user; it is never taken from the body. */
export const CreateBookingBody = z
  .object({
    houseId: z.uuid().toLowerCase(),
    checkIn: calendarDate.describe('First night, inclusive'),
    checkOut: calendarDate.describe('Departure day, exclusive'),
    guests: z.number().int().min(1).max(50),
  })
  .meta({ id: 'CreateBookingBody' });

export const BookingQuery = z.object({
  as: z
    .enum(['guest', 'host', 'any'])
    .default('guest')
    .describe('Your bookings as guest (default), of your houses as host, or all of them (admins).'),
  houseId: z.uuid().toLowerCase().optional(),
});

export const BookingView = z
  .object({
    id: z.uuid(),
    houseId: z.uuid(),
    guestId: z.uuid(),
    hostId: z.uuid().describe('Owner of the house at booking time.'),
    checkIn: z.iso.date(),
    checkOut: z.iso.date(),
    guests: z.number().int(),
    totalPrice: MoneyView,
    status: z.enum(['CONFIRMED', 'CANCELLED']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    cancelledAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Booking' });

export const BookingPage = pageOf(BookingView, 'BookingPage');

/** Domain -> REST. */
export function toBookingView(booking: Booking): z.output<typeof BookingView> {
  const state = booking.toState();
  return {
    id: state.id,
    houseId: state.houseId,
    guestId: state.guestId,
    hostId: state.hostId,
    checkIn: state.checkIn,
    checkOut: state.checkOut,
    guests: state.guests,
    totalPrice: { ...state.totalPrice },
    status: state.status,
    createdAt: state.createdAt.toISOString(),
    updatedAt: state.updatedAt.toISOString(),
    cancelledAt: state.cancelledAt ? state.cancelledAt.toISOString() : null,
  };
}
