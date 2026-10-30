import { ANONYMOUS, PreconditionFailedError } from '@gam/kernel';
import { adminActor, userActor } from '@gam/kernel/testing';
import { describe, expect, it } from 'vitest';
import { GUEST_ID, HOST_ID, HOUSE_ID, STRANGER_ID, TERMS } from '../../test/fakes.ts';
import { Booking } from './booking.ts';

const now = new Date('2026-06-01T12:00:00.000Z');
const input = {
  id: 'b1',
  houseId: HOUSE_ID,
  guestId: GUEST_ID,
  checkIn: '2026-06-10',
  checkOut: '2026-06-13',
  guests: 2,
};

describe('Booking', () => {
  it('prices the stay at nights x nightly price and confirms it', () => {
    const booking = Booking.create(input, TERMS, now);
    expect(booking.toState()).toMatchObject({
      totalPrice: { currencyCode: 'USD', amountMinor: 30_000 },
      status: 'CONFIRMED',
      cancelledAt: null,
    });
  });

  it('refuses more guests than the house sleeps', () => {
    expect(() => Booking.create({ ...input, guests: 5 }, TERMS, now)).toThrow(
      PreconditionFailedError,
    );
  });

  it('cancels once', () => {
    const booking = Booking.create(input, TERMS, now);
    const later = new Date('2026-06-02T00:00:00.000Z');
    booking.cancel(later);
    expect(booking.toState()).toMatchObject({
      status: 'CANCELLED',
      cancelledAt: later,
      updatedAt: later,
    });
    expect(() => booking.cancel(later)).toThrow(PreconditionFailedError);
  });

  it('is visible to its guest, the host and admins only', () => {
    const booking = Booking.create(input, TERMS, now);
    expect(booking.toState().hostId).toBe(HOST_ID);
    for (const actor of [userActor(GUEST_ID), userActor(HOST_ID), adminActor(STRANGER_ID)]) {
      expect(booking.isVisibleTo(actor)).toBe(true);
    }
    expect(booking.isVisibleTo(userActor(STRANGER_ID))).toBe(false);
    expect(booking.isVisibleTo(ANONYMOUS)).toBe(false);
  });
});
