import type { UserActor } from '@gam/kernel';
import { PLATFORM_MIGRATIONS } from '@gam/platform';
import {
  createTestApp,
  createTestDatabase,
  deliverEvent,
  recordedEvents,
  type TestApp,
  type TestDatabase,
} from '@gam/platform/testing';
import { USER_DELETED, UsersApi } from '@gam/users';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HOUSE_DELETED } from '../src/contracts/house-events.ts';
import { HousesModule } from '../src/houses.module.ts';
import { HOUSES_MIGRATIONS } from '../src/migrations.ts';
import { HousesApi } from '../src/transport/api/houses.api.ts';
import { houseInput, OWNER_ID } from './fakes.ts';

const STRANGER = '01900000-0000-7000-8000-0000000000bb';
const GONE = '01900000-0000-7000-8000-0000000000ff';

/** The houses module over HTTP and events, on a real database; the users module is a fake. */
describe('houses', () => {
  const known = new Set([OWNER_ID, STRANGER]);
  const users = { stillExists: async (actor: UserActor) => known.has(actor.userId) };
  let db: TestDatabase;
  let api: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS, HOUSES_MIGRATIONS] });
    api = await createTestApp({
      database: db,
      modules: [HousesModule],
      overrides: new Map([[UsersApi, users]]),
    });
  });

  afterAll(async () => {
    await api?.close();
    await db?.dispose();
  });

  beforeEach(() => db.truncate('houses.houses', 'events.events'));

  async function create(owner = OWNER_ID, overrides: Record<string, unknown> = {}) {
    const response = await api.inject({
      method: 'POST',
      url: '/v1/houses',
      headers: await api.as(owner),
      payload: houseInput(overrides),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; ownerId: string };
  }

  describe('over HTTP', () => {
    it('creates and reads a house with money and address intact', async () => {
      const house = await create();
      expect(house).toMatchObject({
        ownerId: OWNER_ID,
        address: { city: 'Odesa', countryCode: 'UA' },
        nightlyPrice: { currencyCode: 'USD', amountMinor: 12_000 },
        maxGuests: 4,
      });
      const read = await api.inject({ method: 'GET', url: `/v1/houses/${house.id}` });
      expect(read.json()).toMatchObject({ id: house.id, title: 'Sea view loft' });
    });

    it('takes the owner from the signed-in user, never from the body', async () => {
      const house = await create(OWNER_ID, { ownerId: STRANGER });
      expect(house.ownerId).toBe(OWNER_ID);
    });

    it("refuses a house whose owner's account is gone", async () => {
      const response = await api.inject({
        method: 'POST',
        url: '/v1/houses',
        headers: await api.as(GONE),
        payload: houseInput(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('HOUSE_OWNER_NOT_FOUND');
    });

    it('changes nested values only when they are sent', async () => {
      const { id } = await create();
      const headers = await api.as(OWNER_ID);
      const updated = await api.inject({
        method: 'PATCH',
        url: `/v1/houses/${id}`,
        headers,
        payload: { maxGuests: 6 },
      });
      expect(updated.json()).toMatchObject({
        maxGuests: 6,
        address: { city: 'Odesa' },
        nightlyPrice: { amountMinor: 12_000 },
      });
      const repriced = await api.inject({
        method: 'PATCH',
        url: `/v1/houses/${id}`,
        headers,
        payload: { nightlyPrice: { currencyCode: 'EUR', amountMinor: 9_900 } },
      });
      expect(repriced.json().nightlyPrice).toEqual({ currencyCode: 'EUR', amountMinor: 9_900 });
    });

    it('filters by city and binds page tokens to the filter', async () => {
      await create();
      await create(OWNER_ID, { address: { line1: '2 Main', city: 'Kyiv', countryCode: 'UA' } });
      await create(OWNER_ID, { address: { line1: '3 Main', city: 'kyiv', countryCode: 'UA' } });
      const page = (
        await api.inject({ method: 'GET', url: '/v1/houses?pageSize=1&city=KYIV' })
      ).json();
      expect(page.items).toHaveLength(1);
      const next = (
        await api.inject({
          method: 'GET',
          url: `/v1/houses?pageSize=1&city=KYIV&pageToken=${page.nextPageToken}`,
        })
      ).json();
      expect(next.items).toHaveLength(1);
      expect(next.items[0].id).not.toBe(page.items[0].id);
      const mismatch = await api.inject({
        method: 'GET',
        url: `/v1/houses?pageSize=1&city=Odesa&pageToken=${page.nextPageToken}`,
      });
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.json().code).toBe('INVALID_PAGE_TOKEN');
    });

    it('rejects invalid input with nested field paths', async () => {
      const response = await api.inject({
        method: 'POST',
        url: '/v1/houses',
        headers: await api.as(OWNER_ID),
        payload: houseInput({ nightlyPrice: { currencyCode: 'usd', amountMinor: -5 } }),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().errors.map((e: { field: string }) => e.field)).toEqual([
        'nightlyPrice.currencyCode',
        'nightlyPrice.amountMinor',
      ]);
    });

    it('lets anyone read the catalogue, and needs a user to change it', async () => {
      const { id } = await create();
      expect((await api.inject({ method: 'GET', url: `/v1/houses/${id}` })).statusCode).toBe(200);
      for (const request of [
        { method: 'POST' as const, url: '/v1/houses', payload: houseInput() },
        { method: 'PATCH' as const, url: `/v1/houses/${id}`, payload: { maxGuests: 2 } },
        { method: 'DELETE' as const, url: `/v1/houses/${id}` },
      ]) {
        const response = await api.inject(request);
        expect(response.statusCode).toBe(401);
        expect(response.json().code).toBe('AUTH_TOKEN_MISSING');
      }
    });

    it('lets only the owner or an admin change or delete a house', async () => {
      const { id } = await create();
      const stranger = await api.as(STRANGER);
      for (const request of [
        { method: 'PATCH' as const, url: `/v1/houses/${id}`, payload: { maxGuests: 2 } },
        { method: 'DELETE' as const, url: `/v1/houses/${id}` },
      ]) {
        const response = await api.inject({ ...request, headers: stranger });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('HOUSE_PERMISSION_DENIED');
      }
      const admin = await api.as(STRANGER, ['admin']);
      const byAdmin = await api.inject({
        method: 'PATCH',
        url: `/v1/houses/${id}`,
        headers: admin,
        payload: { maxGuests: 2 },
      });
      expect(byAdmin.json().maxGuests).toBe(2);
      const deleted = await api.inject({
        method: 'DELETE',
        url: `/v1/houses/${id}`,
        headers: await api.as(OWNER_ID),
      });
      expect(deleted.statusCode).toBe(204);
      expect((await api.inject({ method: 'GET', url: `/v1/houses/${id}` })).statusCode).toBe(404);
    });
  });

  describe('events', () => {
    it('records HouseDeletedEvent when the owner deletes a house, not when a stranger tries', async () => {
      const { id } = await create();
      await api.inject({
        method: 'DELETE',
        url: `/v1/houses/${id}`,
        headers: await api.as(STRANGER),
      });
      expect(await recordedEvents(api, HOUSE_DELETED.type)).toEqual([]);
      await api.inject({
        method: 'DELETE',
        url: `/v1/houses/${id}`,
        headers: await api.as(OWNER_ID),
      });
      expect(await recordedEvents(api, HOUSE_DELETED.type)).toMatchObject([
        { aggregateId: id, producer: 'houses', payload: { houseId: id, ownerId: OWNER_ID } },
      ]);
    });

    it("deletes a deleted user's houses, announcing each, and keeps everyone else's", async () => {
      const first = await create();
      const second = await create();
      const kept = await create(STRANGER);
      const delivered = await deliverEvent(api, {
        subscriber: 'houses',
        event: USER_DELETED,
        aggregateId: OWNER_ID,
        payload: { userId: OWNER_ID },
      });
      expect(delivered.outcome).toBe('delivered');
      expect((await recordedEvents(api, HOUSE_DELETED.type)).map((e) => e.payload)).toEqual(
        expect.arrayContaining([
          { houseId: first.id, ownerId: OWNER_ID },
          { houseId: second.id, ownerId: OWNER_ID },
        ]),
      );
      // Delivered again (an operator replay): nothing is left to delete or announce.
      const replayed = await deliverEvent(api, {
        subscriber: 'houses',
        event: USER_DELETED,
        aggregateId: OWNER_ID,
        payload: { userId: OWNER_ID },
      });
      expect(replayed.outcome).toBe('delivered');
      expect(await recordedEvents(api, HOUSE_DELETED.type)).toHaveLength(2);
      expect((await api.inject({ method: 'GET', url: `/v1/houses/${first.id}` })).statusCode).toBe(
        404,
      );
      expect((await api.inject({ method: 'GET', url: `/v1/houses/${kept.id}` })).statusCode).toBe(
        200,
      );
    });

    it('accepts a user without houses', async () => {
      const delivered = await deliverEvent(api, {
        subscriber: 'houses',
        event: USER_DELETED,
        aggregateId: STRANGER,
        payload: { userId: STRANGER },
      });
      expect(delivered.outcome).toBe('delivered');
      expect(await recordedEvents(api, HOUSE_DELETED.type)).toEqual([]);
    });
  });

  it('tells other modules about a house, or null', async () => {
    const { id } = await create();
    await expect(api.get(HousesApi).findHouse(id)).resolves.toEqual({
      id,
      ownerId: OWNER_ID,
      maxGuests: 4,
      nightlyPrice: { currencyCode: 'USD', amountMinor: 12_000 },
    });
    await expect(api.get(HousesApi).findHouse(GONE)).resolves.toBeNull();
  });
});
