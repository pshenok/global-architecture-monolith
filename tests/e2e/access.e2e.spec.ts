import { beforeAll, describe, expect, it } from 'vitest';
import { day, grantAdmin, type Session, signUp } from './client.ts';

/** Who may do what, end to end (ADR-0004). Run `pnpm stack:up` first. */
describe('access control (e2e)', () => {
  let owner: Session;
  let guest: Session;
  let stranger: Session;
  let admin: Session;
  let houseId: string;
  let bookingId: string;

  beforeAll(async () => {
    [owner, guest, stranger, admin] = await Promise.all([
      signUp('owner'),
      signUp('guest'),
      signUp('stranger'),
      signUp('admin'),
    ]);
    // Applies to the admin's next request: the API reads roles on every request.
    grantAdmin(admin.userId);
    const house = await owner.call<{ id: string }>('POST', '/v1/houses', {
      title: 'Cabin',
      address: { line1: '5 Forest Rd', city: 'Lviv', countryCode: 'UA' },
      nightlyPrice: { currencyCode: 'EUR', amountMinor: 8_000 },
      maxGuests: 2,
    });
    houseId = house.body.id;
    const booking = await guest.call<{ id: string; hostId: string }>('POST', '/v1/bookings', {
      houseId,
      checkIn: day(60),
      checkOut: day(62),
      guests: 1,
    });
    expect(booking.body.hostId).toBe(owner.userId);
    bookingId = booking.body.id;
  });

  it('lets only the owner (or an admin) change a house', async () => {
    const denied = await stranger.call('PATCH', `/v1/houses/${houseId}`, { maxGuests: 1 });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'HOUSE_PERMISSION_DENIED' });
    expect((await owner.call('PATCH', `/v1/houses/${houseId}`, { maxGuests: 3 })).status).toBe(200);
    expect((await admin.call('PATCH', `/v1/houses/${houseId}`, { maxGuests: 2 })).status).toBe(200);
    expect((await stranger.call('DELETE', `/v1/houses/${houseId}`)).status).toBe(403);
  });

  it('hides a booking from everyone but its guest, its host and admins', async () => {
    for (const session of [guest, owner, admin]) {
      expect((await session.call('GET', `/v1/bookings/${bookingId}`)).status).toBe(200);
    }
    const hidden = await stranger.call('GET', `/v1/bookings/${bookingId}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toMatchObject({ code: 'BOOKING_NOT_FOUND' });
    expect((await stranger.call('POST', `/v1/bookings/${bookingId}/cancel`)).status).toBe(404);
  });

  it('lists bookings per party, and everything for admins only', async () => {
    const asHost = await owner.call<{ items: { id: string }[] }>('GET', '/v1/bookings?as=host');
    expect(asHost.body.items.map((b) => b.id)).toContain(bookingId);
    const asGuest = await owner.call<{ items: unknown[] }>('GET', '/v1/bookings');
    expect(asGuest.body.items).toHaveLength(0);
    const strangers = await stranger.call<{ items: unknown[] }>('GET', '/v1/bookings?as=host');
    expect(strangers.body.items).toHaveLength(0);
    const denied = await stranger.call('GET', '/v1/bookings?as=any');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'ADMIN_ROLE_REQUIRED' });
    const all = await admin.call<{ items: { id: string }[] }>(
      'GET',
      '/v1/bookings?as=any&pageSize=100',
    );
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThan(0);
  });

  it("lets the host cancel a guest's booking", async () => {
    const cancelled = await owner.call<{ status: string }>(
      'POST',
      `/v1/bookings/${bookingId}/cancel`,
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
  });

  it('shows users to themselves and admins; lists them to admins only', async () => {
    expect((await stranger.call('GET', `/v1/users/${owner.userId}`)).status).toBe(404);
    expect((await admin.call('GET', `/v1/users/${owner.userId}`)).status).toBe(200);
    const users = await admin.call<{ items: { id: string }[] }>('GET', '/v1/users?pageSize=100');
    expect(users.status).toBe(200);
    expect((await admin.call<{ roles: string[] }>('GET', '/v1/users/me')).body.roles).toEqual([
      'admin',
    ]);
    const denied = await stranger.call('GET', '/v1/users');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'ADMIN_ROLE_REQUIRED' });
  });

  it('lets a user delete its own account', async () => {
    const leaving = await signUp('leaving');
    expect((await leaving.call('DELETE', '/v1/users/me')).status).toBe(204);
    // Logins are resolved on every request: the very next one has no user behind it.
    const after = await leaving.call('GET', '/v1/users/me');
    expect(after.status).toBe(403);
    expect(after.body).toMatchObject({ code: 'USER_NOT_REGISTERED' });
  });
});
