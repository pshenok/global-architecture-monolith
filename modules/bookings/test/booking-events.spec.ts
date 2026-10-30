import { randomUUID } from 'node:crypto';
import { HOUSE_DELETED } from '@gam/houses';
import { PLATFORM_MIGRATIONS } from '@gam/platform';
import {
  createTestApp,
  createTestDatabase,
  deliverEvent,
  type TestApp,
  type TestDatabase,
} from '@gam/platform/testing';
import { USER_DELETED } from '@gam/users';
import type { InjectionToken } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  OTHER_HOUSE,
  TERMS,
} from './fakes.ts';

/** Bookings follow deleted houses and users (ADR-0005), on real Postgres. */
describe('booking events', () => {
  let db: TestDatabase;
  let api: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS, BOOKINGS_MIGRATIONS] });
    api = await createTestApp({
      database: db,
      modules: [BookingsModule],
      overrides: new Map<InjectionToken, unknown>([
        [UserDirectory, new FakeUserDirectory()],
        [
          HouseCatalog,
          new FakeHouseCatalog(
            new Map([
              [HOUSE_ID, TERMS],
              [OTHER_HOUSE, TERMS],
            ]),
          ),
        ],
      ]),
    });
  });

  afterAll(async () => {
    await api?.close();
    await db?.dispose();
  });

  beforeEach(() => db.truncate('bookings.bookings', 'events.events'));

  const book = async (houseId: string, from: number, to: number) => {
    const response = await api.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: await api.as(GUEST_ID),
      payload: { houseId, checkIn: day(from), checkOut: day(to), guests: 1 },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  };
  const cancel = async (id: string) =>
    api.inject({
      method: 'POST',
      url: `/v1/bookings/${id}/cancel`,
      headers: await api.as(GUEST_ID),
    });
  const statusOf = async (id: string) =>
    (
      await db.pool.query(
        'select status, cancelled_at, updated_at from bookings.bookings where id = $1',
        [id],
      )
    ).rows[0] as { status: string; cancelled_at: Date | null; updated_at: Date };
  /**
   * A stay inserted directly, without the API's own date checks: it refuses stays that
   * checked in before today, and checks "today" with the server's clock, not the test's.
   */
  const insertStay = async (houseId: string, from: number, to: number, guestId = GUEST_ID) => {
    const id = randomUUID();
    await db.pool.query(
      `insert into bookings.bookings (id, house_id, guest_id, host_id, check_in, check_out, guests,
         total_price_minor, currency_code, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 1, 100, 'USD', 'CONFIRMED', now(), now())`,
      [id, houseId, guestId, HOST_ID, day(from), day(to)],
    );
    return id;
  };
  const houseDeleted = (houseId = HOUSE_ID) =>
    deliverEvent(api, {
      subscriber: 'bookings',
      event: HOUSE_DELETED,
      aggregateId: houseId,
      payload: { houseId, ownerId: HOST_ID },
    });
  const userDeleted = (userId: string) =>
    deliverEvent(api, {
      subscriber: 'bookings',
      event: USER_DELETED,
      aggregateId: userId,
      payload: { userId },
    });

  it("cancels a deleted house's upcoming and ongoing stays, and frees their dates", async () => {
    const upcoming = await book(HOUSE_ID, 10, 12);
    const cancelledBefore = await book(HOUSE_ID, 20, 21);
    await cancel(cancelledBefore);
    const asCancelled = await statusOf(cancelledBefore);
    const elsewhere = await book(OTHER_HOUSE, 10, 12);
    // The deleted house's owner travelling as a guest elsewhere: HouseDeletedEvent leaves it.
    const ownersTrip = await insertStay(OTHER_HOUSE, 20, 22, HOST_ID);
    // Finished first: if midnight passes in between, the ongoing stay moves later, not onto it.
    const finished = await insertStay(HOUSE_ID, -3, 0);
    const ongoing = await insertStay(HOUSE_ID, 0, 2);

    expect((await houseDeleted()).outcome).toBe('delivered');
    for (const cancelled of [upcoming, ongoing]) {
      expect(await statusOf(cancelled)).toMatchObject({
        status: 'CANCELLED',
        cancelled_at: expect.any(Date),
      });
    }
    expect((await statusOf(elsewhere)).status).toBe('CONFIRMED');
    expect((await statusOf(ownersTrip)).status).toBe('CONFIRMED');
    expect((await statusOf(finished)).status).toBe('CONFIRMED');
    expect(await statusOf(cancelledBefore)).toEqual(asCancelled);
    // Delivered again (an operator replay): nothing changes.
    expect((await houseDeleted()).outcome).toBe('delivered');
    expect(await statusOf(cancelledBefore)).toEqual(asCancelled);
    await expect(book(HOUSE_ID, 10, 12)).resolves.toEqual(expect.any(String));
  });

  it("cancels a deleted house's stay that checked in before today", async () => {
    // Apart from the test above: it would overlap the stays checking in and out today.
    const inProgress = await insertStay(HOUSE_ID, -1, 2);
    expect((await houseDeleted()).outcome).toBe('delivered');
    expect((await statusOf(inProgress)).status).toBe('CANCELLED');
  });

  it("cancels a deleted guest's stays, but not the stays that user hosts", async () => {
    const upcoming = await book(HOUSE_ID, 10, 12);
    const inProgress = await insertStay(HOUSE_ID, -1, 2);
    // Another house: it would overlap the stay in progress.
    const finished = await insertStay(OTHER_HOUSE, -3, 0);
    const cancelledBefore = await book(HOUSE_ID, 20, 21);
    await cancel(cancelledBefore);
    const asCancelled = await statusOf(cancelledBefore);
    // Its host's stays go with the host's houses (HouseDeletedEvent), not here.
    expect((await userDeleted(HOST_ID)).outcome).toBe('delivered');
    for (const booking of [upcoming, inProgress, finished]) {
      expect((await statusOf(booking)).status).toBe('CONFIRMED');
    }
    expect((await userDeleted(GUEST_ID)).outcome).toBe('delivered');
    for (const booking of [upcoming, inProgress]) {
      expect((await statusOf(booking)).status).toBe('CANCELLED');
    }
    expect((await statusOf(finished)).status).toBe('CONFIRMED');
    expect(await statusOf(cancelledBefore)).toEqual(asCancelled);
  });

  it('changes nothing when a UserDeletedEvent is delivered again', async () => {
    const upcoming = await insertStay(HOUSE_ID, 10, 12);
    expect((await userDeleted(GUEST_ID)).outcome).toBe('delivered');
    const asCancelled = await statusOf(upcoming);
    expect(asCancelled.status).toBe('CANCELLED');
    expect((await userDeleted(GUEST_ID)).outcome).toBe('delivered');
    expect(await statusOf(upcoming)).toEqual(asCancelled);
  });
});
