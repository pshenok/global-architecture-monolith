import { beforeAll, describe, expect, it } from 'vitest';
import { api, day, eventually, type Session, signUp } from './client.ts';

interface Booking {
  id: string;
  status: string;
}

/**
 * Deletions clean up what references them through in-process events (ADR-0005):
 * users -> houses -> bookings. Run `pnpm stack:up` first.
 */
describe('asynchronous events (e2e)', () => {
  let nextDay = 100;
  /** A stay on fresh dates, so tests never collide on a house's calendar. */
  const stay = () => {
    nextDay += 3;
    return { checkIn: day(nextDay), checkOut: day(nextDay + 2) };
  };

  const listHouse = async (owner: Session) =>
    (
      await owner.call<{ id: string }>('POST', '/v1/houses', {
        title: 'Event cabin',
        address: { line1: '1 Queue St', city: 'Kyiv', countryCode: 'UA' },
        nightlyPrice: { currencyCode: 'EUR', amountMinor: 5_000 },
        maxGuests: 2,
      })
    ).body.id;
  const book = async (guest: Session, houseId: string) => {
    const booking = await guest.call<Booking>('POST', '/v1/bookings', {
      houseId,
      ...stay(),
      guests: 1,
    });
    expect(booking.status).toBe(201);
    return booking.body.id;
  };
  const statusSeenBy = async (session: Session, bookingId: string) => {
    const booking = await session.call<Booking>('GET', `/v1/bookings/${bookingId}`);
    expect(booking.status).toBe(200);
    return booking.body.status;
  };
  const cancelledFor = (session: Session, bookingId: string) =>
    eventually(async () => expect(await statusSeenBy(session, bookingId)).toBe('CANCELLED'));

  beforeAll(async () => {
    const ready = await api<{ status: string }>('GET', '/readyz');
    expect(ready.body.status, 'run pnpm stack:up first').toBe('ok');
  });

  it("cancels a deleted house's bookings", async () => {
    const [owner, guest] = await Promise.all([signUp('ev-owner'), signUp('ev-guest')]);
    const houseId = await listHouse(owner);
    const bookingId = await book(guest, houseId);
    expect((await owner.call('DELETE', `/v1/houses/${houseId}`)).status).toBe(204);
    await cancelledFor(guest, bookingId);
  });

  it("cancels a deleted guest's bookings", async () => {
    const [owner, guest] = await Promise.all([signUp('ev-host'), signUp('ev-leaving')]);
    const houseId = await listHouse(owner);
    const bookingId = await book(guest, houseId);
    expect((await guest.call('DELETE', '/v1/users/me')).status).toBe(204);
    await cancelledFor(owner, bookingId);
  });

  it("removes a deleted host's houses, and through them their bookings", async () => {
    const [host, guest] = await Promise.all([signUp('ev-gone-host'), signUp('ev-stays')]);
    const houseId = await listHouse(host);
    const bookingId = await book(guest, houseId);
    expect((await host.call('DELETE', '/v1/users/me')).status).toBe(204);
    await eventually(async () =>
      expect((await api('GET', `/v1/houses/${houseId}`)).status).toBe(404),
    );
    await cancelledFor(guest, bookingId);
  });
});
