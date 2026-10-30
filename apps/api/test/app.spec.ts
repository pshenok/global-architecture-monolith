import { readFileSync } from 'node:fs';
import * as bookings from '@gam/bookings';
import * as houses from '@gam/houses';
import { eventCatalog, IdentityResolver, isModuleApi } from '@gam/platform';
import {
  createTestApp,
  createTestDatabase,
  flushEvents,
  recordedEvents,
  type TestApp,
  type TestDatabase,
} from '@gam/platform/testing';
import * as users from '@gam/users';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { parseSince } from '../src/cli/parse-since.ts';
import { MIGRATIONS } from '../src/migrations.ts';

const day = (n: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n))
    .toISOString()
    .slice(0, 10);
};

/**
 * The whole app (every module, the real identity resolution), on a database with every
 * migration: the composition works, the open routes are the reviewed ones, and the
 * modules clean up after each other through events.
 */
describe('the app', () => {
  let db: TestDatabase;
  let api: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase({ migrations: MIGRATIONS });
    api = await createTestApp({
      database: db,
      app: AppModule,
      identities: 'app',
      checkPublicEndpoints: true,
    });
  });

  afterAll(async () => {
    await api?.close();
    await db?.dispose();
  });

  beforeEach(() =>
    db.truncate('users.users', 'houses.houses', 'bookings.bookings', 'events.events'),
  );

  const login = (subject: string) =>
    api.bearer(subject, { email: `${subject}@example.com`, emailVerified: true });

  async function call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    subject?: string,
    payload?: object,
  ) {
    const response = await api.inject({
      method,
      url,
      ...(subject ? { headers: await login(subject) } : {}),
      ...(payload ? { payload } : {}),
    });
    return { status: response.statusCode, body: response.body ? response.json() : undefined };
  }

  async function setUp() {
    const host = (await call('POST', '/v1/users', 'host', { fullName: 'Host' })).body;
    const guest = (await call('POST', '/v1/users', 'guest', { fullName: 'Guest' })).body;
    const house = (
      await call('POST', '/v1/houses', 'host', {
        title: 'Loft',
        address: { line1: '1 Main', city: 'Odesa', countryCode: 'UA' },
        nightlyPrice: { currencyCode: 'USD', amountMinor: 10_000 },
        maxGuests: 2,
      })
    ).body;
    const booked = await call('POST', '/v1/bookings', 'guest', {
      houseId: house.id,
      checkIn: day(10),
      checkOut: day(12),
      guests: 2,
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    return { host, guest, house, booking: booked.body };
  }

  it('registers, lists a house and books it, across the modules', async () => {
    const { host, guest, house, booking } = await setUp();
    expect(house.ownerId).toBe(host.id);
    expect(booking).toMatchObject({
      guestId: guest.id,
      hostId: host.id,
      totalPrice: { currencyCode: 'USD', amountMinor: 20_000 },
    });
    const asHost = await call('GET', '/v1/bookings?as=host', 'host');
    expect(asHost.body.items.map((b: { id: string }) => b.id)).toEqual([booking.id]);
  });

  it('deleting a host removes its houses, then cancels their stays, through events', async () => {
    const { house, booking } = await setUp();
    expect((await call('DELETE', '/v1/users/me', 'host')).status).toBe(204);
    // users -> UserDeletedEvent -> houses deletes the house -> HouseDeletedEvent -> bookings.
    expect(await flushEvents(api)).toBe(3);
    expect((await call('GET', `/v1/houses/${house.id}`)).status).toBe(404);
    expect((await call('GET', `/v1/bookings/${booking.id}`, 'guest')).body.status).toBe(
      'CANCELLED',
    );
    const events = await recordedEvents(api);
    expect(events.map((event) => [event.type, event.deliveries.map((d) => d.status)])).toEqual([
      ['users.v1.UserDeletedEvent', ['delivered', 'delivered']],
      ['houses.v1.HouseDeletedEvent', ['delivered']],
    ]);
    expect(events[1]?.requestId).toBe(events[0]?.requestId);
  });

  it("deleting a guest cancels its stays and keeps the host's house", async () => {
    const { house, booking } = await setUp();
    expect((await call('DELETE', '/v1/users/me', 'guest')).status).toBe(204);
    await flushEvents(api);
    expect((await call('GET', `/v1/houses/${house.id}`)).status).toBe(200);
    expect((await call('GET', `/v1/bookings/${booking.id}`, 'host')).body.status).toBe('CANCELLED');
  });

  it('publishes one OpenAPI document with bearer security on every non-public operation', async () => {
    const document = (await call('GET', '/openapi.json')).body;
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/v1/bookings',
        '/v1/bookings/{id}',
        '/v1/bookings/{id}/cancel',
        '/v1/houses',
        '/v1/houses/{id}',
        '/v1/users',
        '/v1/users/{id}',
      ]),
    );
    const body = document.paths['/v1/users'].post.requestBody.content['application/json'].schema;
    expect(body).toEqual({ $ref: '#/components/schemas/RegisterUserBody' });
    const operations = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(
        item as Record<string, { security?: unknown[]; responses: Record<string, unknown> }>,
      ).map(([method, operation]) => ({ id: `${method.toUpperCase()} ${path}`, operation })),
    );
    const open = operations
      .filter(({ operation }) => operation.security?.length === 0)
      .map(({ id }) => id);
    expect(open.sort()).toEqual(['GET /v1/houses', 'GET /v1/houses/{id}']);
    for (const { id, operation } of operations) {
      if (open.includes(id)) continue;
      expect(operation.responses, id).toHaveProperty('401');
      expect(operation.responses, id).toHaveProperty('403');
    }
  });

  it('is ready once its database answered', async () => {
    const ready = await call('GET', '/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body.database).toBe('ok');
  });
});

describe('operator commands', () => {
  it('know which module handles which event, from the modules themselves', () => {
    expect(eventCatalog()).toEqual(
      expect.arrayContaining([
        { subscriber: 'houses', type: 'users.v1.UserDeletedEvent' },
        { subscriber: 'bookings', type: 'users.v1.UserDeletedEvent' },
        { subscriber: 'bookings', type: 'houses.v1.HouseDeletedEvent' },
      ]),
    );
    expect(eventCatalog()).toHaveLength(3);
  });

  it('apply the platform migrations first, then every module of modules.json', () => {
    const registry = JSON.parse(
      readFileSync(new URL('../../../modules.json', import.meta.url), 'utf8'),
    ) as { modules: { name: string }[] };
    expect(MIGRATIONS.map((set) => set.name)).toEqual([
      'platform',
      ...registry.modules.map((module) => module.name),
    ]);
  });

  it('take --since only as a full ISO time with a zone', () => {
    expect(parseSince('2026-10-01T00:00:00Z')).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(parseSince('2026-10-01T02:30+02:30')).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(parseSince('2026-10-01T23:30:00.500-05:00')?.toISOString()).toBe(
      '2026-10-02T04:30:00.500Z',
    );
    for (const typo of ['2026-02-30T00:00:00Z', '2026-10-01', '1', '0', '', '2026-10-01T25:00Z']) {
      expect(parseSince(typo)).toBeUndefined();
    }
    expect(parseSince(undefined)).toBeUndefined();
  });

  it('find in each module public API only its Nest module and ModuleApi classes', () => {
    for (const [name, exports] of Object.entries({ users, houses, bookings })) {
      for (const [key, value] of Object.entries(exports)) {
        if (typeof value !== 'function') continue;
        const allowed =
          key.endsWith('Module') ||
          isModuleApi(value) ||
          (value as { prototype?: unknown }).prototype instanceof IdentityResolver;
        expect(
          allowed,
          `${name} exports ${key}, neither its Nest module nor a @ModuleApi class`,
        ).toBe(true);
      }
    }
  });
});
