import { PLATFORM_MIGRATIONS } from '@gam/platform';
import {
  createTestApp,
  createTestDatabase,
  type InjectResponse,
  type TestApp,
  type TestDatabase,
} from '@gam/platform/testing';
import type { InjectionToken } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HouseCatalog } from '../src/application/ports/house-catalog.ts';
import { UserDirectory } from '../src/application/ports/user-directory.ts';
import { BookingsModule } from '../src/bookings.module.ts';
import { BOOKINGS_MIGRATIONS } from '../src/migrations.ts';
import {
  day,
  FakeHouseCatalog,
  FakeUserDirectory,
  GUEST_ID,
  HOST_ID,
  HOUSE_ID,
  STRANGER_ID,
} from './fakes.ts';

/** The bookings module over HTTP on a real database; users and houses are fakes of its ports. */
describe('bookings over HTTP', () => {
  let db: TestDatabase;
  let api: TestApp;
  let asGuest: Record<string, string>;

  beforeAll(async () => {
    db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS, BOOKINGS_MIGRATIONS] });
    api = await createTestApp({
      database: db,
      modules: [BookingsModule],
      // The concurrent-cancel test queues six requests on a row lock: under a busy machine
      // (every package's tests at once) that can take longer than the default 1.5 s.
      env: { DB_STATEMENT_TIMEOUT_MS: '10000' },
      overrides: new Map<InjectionToken, unknown>([
        [UserDirectory, new FakeUserDirectory(new Set([GUEST_ID, HOST_ID, STRANGER_ID]))],
        [HouseCatalog, new FakeHouseCatalog()],
      ]),
    });
    asGuest = await api.as(GUEST_ID);
  });

  afterAll(async () => {
    await api?.close();
    await db?.dispose();
  });

  beforeEach(() => db.truncate('bookings.bookings'));

  const body = (from: number, to: number, guests = 2) => ({
    houseId: HOUSE_ID,
    checkIn: day(from),
    checkOut: day(to),
    guests,
  });
  const book = (from: number, to: number, guests = 2, headers = asGuest) =>
    api.inject({ method: 'POST', url: '/v1/bookings', headers, payload: body(from, to, guests) });
  const cancel = (id: string, headers = asGuest) =>
    api.inject({ method: 'POST', url: `/v1/bookings/${id}/cancel`, headers });
  const list = (query: string, headers: Record<string, string>) =>
    api.inject({ method: 'GET', url: `/v1/bookings?${query}`, headers });
  const ok = (response: InjectResponse) => {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json();
  };

  it('confirms a booking for the caller with the frozen total price and the host', async () => {
    const response = await api.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: asGuest,
      payload: { ...body(10, 13), guestId: STRANGER_ID },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe(`/v1/bookings/${response.json().id}`);
    expect(response.json()).toMatchObject({
      guestId: GUEST_ID,
      hostId: HOST_ID,
      status: 'CONFIRMED',
      totalPrice: { currencyCode: 'USD', amountMinor: 30_000 },
      checkIn: day(10),
      checkOut: day(13),
      cancelledAt: null,
    });
  });

  it('lets exactly one of many concurrent overlapping requests win', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => book(20 + (i % 2), 23)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    for (const result of results.filter((r) => r.statusCode !== 201)) {
      expect(result.statusCode).toBe(409);
      expect(result.json().code).toBe('BOOKING_DATES_UNAVAILABLE');
    }
  });

  it('refuses overlaps, allows back-to-back stays, and frees the dates on cancel', async () => {
    const booking = ok(await book(10, 13));
    const overlap = await book(12, 14);
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json()).toMatchObject({
      code: 'BOOKING_DATES_UNAVAILABLE',
      metadata: { houseId: HOUSE_ID },
    });
    expect((await book(13, 15)).statusCode).toBe(201);
    const cancelled = ok(await cancel(booking.id));
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelledAt: expect.any(String) });
    expect((await book(10, 13)).statusCode).toBe(201);
    const again = await cancel(booking.id);
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe('BOOKING_ALREADY_CANCELLED');
  });

  it('answers business rule failures with 400 and their reason, and bad input with the field', async () => {
    const crowded = await book(10, 12, 5);
    expect(crowded.statusCode).toBe(400);
    expect(crowded.json().code).toBe('BOOKING_TOO_MANY_GUESTS');
    const unknownHouse = await api.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: asGuest,
      payload: { ...body(10, 12), houseId: '01900000-0000-7000-8000-0000000000ff' },
    });
    expect(unknownHouse.json().code).toBe('BOOKING_HOUSE_NOT_FOUND');
    const badDate = await api.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: asGuest,
      payload: { ...body(10, 12), checkIn: '2026-02-30' },
    });
    expect(badDate.statusCode).toBe(400);
    expect(badDate.json().errors[0].field).toBe('checkIn');
    const past = await book(-2, 1);
    expect(past.statusCode).toBe(400);
    expect(past.json().errors[0].field).toBe('checkIn');
  });

  it('refuses a guest whose account is gone', async () => {
    const response = await book(10, 12, 2, await api.as('01900000-0000-7000-8000-0000000000ee'));
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('BOOKING_GUEST_NOT_FOUND');
  });

  describe('access', () => {
    it('needs a signed-in user for every route', async () => {
      const booking = ok(await book(10, 11));
      for (const request of [
        { method: 'POST' as const, url: '/v1/bookings', payload: body(12, 13) },
        { method: 'GET' as const, url: `/v1/bookings/${booking.id}` },
        { method: 'GET' as const, url: '/v1/bookings' },
        { method: 'POST' as const, url: `/v1/bookings/${booking.id}/cancel` },
      ]) {
        const response = await api.inject(request);
        expect(response.statusCode).toBe(401);
      }
    });

    it('shows a booking to its guest, its host and admins; others get 404', async () => {
      const { id } = ok(await book(10, 13));
      for (const headers of [
        asGuest,
        await api.as(HOST_ID),
        await api.as(STRANGER_ID, ['admin']),
      ]) {
        expect(ok(await api.inject({ method: 'GET', url: `/v1/bookings/${id}`, headers })).id).toBe(
          id,
        );
      }
      const stranger = await api.as(STRANGER_ID);
      for (const response of [
        await api.inject({ method: 'GET', url: `/v1/bookings/${id}`, headers: stranger }),
        await cancel(id, stranger),
      ]) {
        expect(response.statusCode).toBe(404);
        expect(response.json().code).toBe('BOOKING_NOT_FOUND');
      }
    });

    it('lets the host cancel', async () => {
      const { id } = ok(await book(10, 13));
      expect(ok(await cancel(id, await api.as(HOST_ID))).status).toBe('CANCELLED');
    });

    it('lets exactly one of many concurrent cancels win (guest and host)', async () => {
      const { id } = ok(await book(14, 16));
      const host = await api.as(HOST_ID);
      // Hold the row until every cancel is waiting on it, so their transactions really
      // overlap; without the row lock in the use case, several of them would succeed.
      const blocker = await db.pool.connect();
      let calls: Promise<InjectResponse>[] = [];
      try {
        await blocker.query('begin');
        await blocker.query('select 1 from bookings.bookings where id = $1 for update', [id]);
        const xid = (
          await blocker.query<{ xid: string }>('select pg_current_xact_id()::xid::text as xid')
        ).rows[0]?.xid;
        calls = Array.from({ length: 6 }, (_, i) => cancel(id, i % 2 ? host : asGuest));
        // The first queues on the blocker's transaction, the rest on the row's tuple lock.
        await vi.waitFor(
          async () => {
            const { rows } = await db.pool.query<{ waiting: number }>(
              `select count(distinct pid)::int as waiting from pg_locks
                where not granted and (relation = 'bookings.bookings'::regclass or transactionid = $1::xid)`,
              [xid],
            );
            expect(rows[0]?.waiting).toBe(6);
          },
          { timeout: 5_000, interval: 20 },
        );
        await blocker.query('commit');
        const results = await Promise.all(calls);
        expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
        for (const loser of results.filter((r) => r.statusCode !== 200)) {
          expect(loser.json().code).toBe('BOOKING_ALREADY_CANCELLED');
        }
      } finally {
        await blocker.query('rollback').catch(() => undefined);
        blocker.release();
        await Promise.allSettled(calls);
      }
    });

    it("lists only the caller's bookings, as guest or as host", async () => {
      ok(await book(10, 11));
      ok(await book(11, 12));
      const host = await api.as(HOST_ID);
      const stranger = await api.as(STRANGER_ID);
      expect(ok(await list('', asGuest)).items).toHaveLength(2);
      expect(ok(await list('as=host', host)).items).toHaveLength(2);
      expect(ok(await list('as=guest', host)).items).toHaveLength(0);
      expect(ok(await list('as=host', stranger)).items).toHaveLength(0);
      expect(ok(await list('as=guest', stranger)).items).toHaveLength(0);
      const noHouse = await list('houseId=01900000-0000-7000-8000-0000000000ff', asGuest);
      expect(ok(noHouse).items).toHaveLength(0);
    });

    it('lists every booking for admins only', async () => {
      ok(await book(10, 11));
      const denied = await list('as=any', await api.as(STRANGER_ID));
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe('ADMIN_ROLE_REQUIRED');
      expect(ok(await list('as=any', await api.as(STRANGER_ID, ['admin']))).items).toHaveLength(1);
    });

    it('binds page tokens to the caller and the party', async () => {
      ok(await book(10, 11));
      ok(await book(11, 12));
      const first = ok(await list('pageSize=1', asGuest));
      expect(first.nextPageToken).not.toBeNull();
      const next = ok(await list(`pageSize=1&pageToken=${first.nextPageToken}`, asGuest));
      expect(next.items).toHaveLength(1);
      for (const [query, headers] of [
        [`as=host&pageToken=${first.nextPageToken}`, asGuest],
        [`as=guest&pageToken=${first.nextPageToken}`, await api.as(HOST_ID)],
      ] as const) {
        const response = await list(query, headers);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('INVALID_PAGE_TOKEN');
      }
    });
  });
});
