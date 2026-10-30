import { connect } from 'node:http2';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  BASE_URL,
  bearer,
  CA,
  day,
  IDP_URL,
  idpToken,
  raw,
  type Session,
  signUp,
  unique,
} from './client.ts';

/**
 * The whole system over the wire: dev IdP -> HTTPS API (every module in one process) ->
 * Postgres. Run `pnpm stack:up` first.
 */
describe('global-architecture-monolith stack (e2e)', () => {
  let owner: Session;
  let guest: Session;
  let houseId: string;

  beforeAll(async () => {
    const ready = await api<{ status: string; identityProvider: string }>('GET', '/readyz');
    expect(ready.status, `stack not ready: ${JSON.stringify(ready.body)}`).toBe(200);
    // `status` says whether the database and the identity provider are both well.
    expect(ready.body.status, `stack degraded: ${JSON.stringify(ready.body)}`).toBe('ok');
    expect(ready.body.identityProvider).toBe('ok');
  });

  it('serves HTTP/2 over TLS', async () => {
    const session = connect(BASE_URL, { ca: CA });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const stream = session.request({ ':path': '/healthz' });
        stream.on('response', (headers) => resolve(Number(headers[':status'])));
        stream.on('error', reject);
        stream.end();
      });
      expect(status).toBe(200);
      expect(session.alpnProtocol).toBe('h2');
    } finally {
      session.close();
    }
  });

  describe('authentication', () => {
    it('registers a login once, with the email the identity provider verified', async () => {
      owner = await signUp('owner');
      guest = await signUp('guest');
      const me = await owner.call<{ id: string; email: string; roles: string[] }>(
        'GET',
        '/v1/users/me',
      );
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ id: owner.userId, email: owner.email, roles: [] });

      const again = await owner.call('POST', '/v1/users', { fullName: 'Owner again' });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'USER_ALREADY_REGISTERED' });
    });

    it('refuses a second login with a taken email, and an unverified email', async () => {
      const imposter = await idpToken(unique('imposter'), {
        email: owner.email.toUpperCase(),
        emailVerified: true,
      });
      const taken = await api('POST', '/v1/users', { fullName: 'Imposter' }, bearer(imposter));
      expect(taken.status).toBe(409);
      expect(taken.body).toMatchObject({ code: 'USER_EMAIL_TAKEN' });

      const unverified = await idpToken(unique('unverified'), {
        email: `${unique('u')}@example.com`,
        emailVerified: false,
      });
      const refused = await api('POST', '/v1/users', { fullName: 'U' }, bearer(unverified));
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    });

    it('answers 401 without or with a bad token, and 403 before registration', async () => {
      const missing = await api('GET', '/v1/users/me');
      expect(missing.status).toBe(401);
      expect(missing.headers['www-authenticate']).toBe('Bearer realm="gam"');
      expect(missing.body).toMatchObject({ code: 'AUTH_TOKEN_MISSING' });

      const forged = `${owner.token.slice(0, -4)}AAAA`;
      const invalid = await api('GET', '/v1/users/me', undefined, bearer(forged));
      expect(invalid.status).toBe(401);
      expect(invalid.body).toMatchObject({ code: 'AUTH_TOKEN_INVALID' });

      // A token the same IdP issued for another client (audience) is not an API token.
      const forClient = await fetch(`${IDP_URL}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sub: owner.sub, audience: 'some-spa-client' }),
      }).then((r) => r.json() as Promise<{ access_token: string }>);
      const wrongAudience = await api(
        'GET',
        '/v1/users/me',
        undefined,
        bearer(forClient.access_token),
      );
      expect(wrongAudience.status).toBe(401);
      expect(wrongAudience.body).toMatchObject({ code: 'AUTH_TOKEN_INVALID' });

      const stranger = await idpToken(unique('stranger'));
      const unregistered = await api('GET', '/v1/users/me', undefined, bearer(stranger));
      expect(unregistered.status).toBe(403);
      expect(unregistered.body).toMatchObject({ code: 'USER_NOT_REGISTERED' });
    });

    it('trusts a rotated identity-provider key right away', async () => {
      const rotated = await fetch(`${IDP_URL}/rotate`, { method: 'POST' });
      expect(rotated.status).toBe(200);
      const token = await idpToken(owner.sub);
      expect((await api('GET', '/v1/users/me', undefined, bearer(token))).status).toBe(200);
      // Tokens signed with the previous key keep working until they expire.
      expect((await owner.call('GET', '/v1/users/me')).status).toBe(200);
    });
  });

  it('lists a house owned by the signed-in user, whatever the body says', async () => {
    const house = await owner.call<{ id: string; ownerId: string }>('POST', '/v1/houses', {
      ownerId: guest.userId,
      title: 'Loft by the sea',
      address: { line1: '1 Frantsuzky Blvd', city: 'Odesa', countryCode: 'UA' },
      nightlyPrice: { currencyCode: 'USD', amountMinor: 12_500 },
      maxGuests: 3,
    });
    expect(house.status).toBe(201);
    expect(house.body.ownerId).toBe(owner.userId);
    houseId = house.body.id;

    const anonymous = await api<{ id: string }>('GET', `/v1/houses/${houseId}`);
    expect(anonymous.status).toBe(200);
    expect((await api('POST', '/v1/houses', {})).status).toBe(401);
  });

  it('books, prices, prevents overlaps, cancels and rebooks (booking -> user + house)', async () => {
    const stay = { houseId, checkIn: day(30), checkOut: day(33), guests: 2 };
    const booking = await guest.call<{
      id: string;
      status: string;
      guestId: string;
      hostId: string;
      totalPrice: { amountMinor: number };
    }>('POST', '/v1/bookings', stay);
    expect(booking.status).toBe(201);
    expect(booking.body).toMatchObject({
      status: 'CONFIRMED',
      guestId: guest.userId,
      totalPrice: { currencyCode: 'USD', amountMinor: 37_500 },
    });

    const overlap = await guest.call('POST', '/v1/bookings', {
      ...stay,
      checkIn: day(32),
      checkOut: day(35),
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body).toMatchObject({ code: 'BOOKING_DATES_UNAVAILABLE' });

    const backToBack = await guest.call('POST', '/v1/bookings', {
      ...stay,
      checkIn: day(33),
      checkOut: day(34),
    });
    expect(backToBack.status).toBe(201);

    const crowded = await guest.call('POST', '/v1/bookings', {
      ...stay,
      checkIn: day(40),
      checkOut: day(41),
      guests: 4,
    });
    expect(crowded.status).toBe(400);
    expect(crowded.body).toMatchObject({ code: 'BOOKING_TOO_MANY_GUESTS' });

    const cancelled = await guest.call<{ status: string; cancelledAt: string }>(
      'POST',
      `/v1/bookings/${booking.body.id}/cancel`,
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.cancelledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const again = await guest.call('POST', `/v1/bookings/${booking.body.id}/cancel`);
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ code: 'BOOKING_ALREADY_CANCELLED' });

    const rebooked = await guest.call('POST', '/v1/bookings', stay);
    expect(rebooked.status).toBe(201);
  });

  it('lets exactly one of many concurrent requests for the same dates win', async () => {
    const stay = { houseId, checkIn: day(50), checkOut: day(52), guests: 1 };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => guest.call('POST', '/v1/bookings', stay)),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
  });

  it("pages the caller's bookings with opaque tokens", async () => {
    const first = await guest.call<{ items: { guestId: string }[]; nextPageToken: string | null }>(
      'GET',
      '/v1/bookings?pageSize=2',
    );
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.items.every((b) => b.guestId === guest.userId)).toBe(true);
    expect(first.body.nextPageToken).toBeTypeOf('string');

    const token = encodeURIComponent(first.body.nextPageToken as string);
    const second = await guest.call<{ items: unknown[] }>(
      'GET',
      `/v1/bookings?pageSize=2&pageToken=${token}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.items.length).toBeGreaterThan(0);

    const tampered = await guest.call(
      'GET',
      `/v1/bookings?houseId=${houseId}&pageSize=2&pageToken=${token}`,
    );
    expect(tampered.status).toBe(400);
    expect(tampered.body).toMatchObject({ code: 'INVALID_PAGE_TOKEN' });
  });

  it('returns field-level validation errors and 404s as problem+json', async () => {
    const invalid = await guest.call<{ errors: { field: string }[] }>('POST', '/v1/bookings', {
      houseId: 'nope',
      checkIn: '2026-02-30',
      checkOut: day(2),
      guests: 0,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.errors.map((e) => e.field)).toEqual(['houseId', 'checkIn', 'guests']);

    const missing = await api('GET', '/v1/houses/01900000-0000-7000-8000-00000000beef');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'HOUSE_NOT_FOUND' });
  });

  it('serves the OpenAPI document and the docs UI', async () => {
    const document = await api<{
      openapi: string;
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    }>('GET', '/openapi.json');
    expect(document.body.openapi).toMatch(/^3\./);
    expect(Object.keys(document.body.paths)).toContain('/v1/bookings/{id}/cancel');
    expect(document.body.components.securitySchemes).toHaveProperty('bearer');
    const docs = await raw('/docs');
    expect(docs.status).toBe(200);
    expect(docs.contentType).toContain('text/html');
    expect(docs.text).toContain('Scalar API Reference');
  });
});
