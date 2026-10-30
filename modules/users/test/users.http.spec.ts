import { UnitOfWork } from '@gam/kernel';
import { adminActor, userActor } from '@gam/kernel/testing';
import { CrossModuleCallInTransactionError, PLATFORM_MIGRATIONS } from '@gam/platform';
import {
  createTestApp,
  createTestDatabase,
  recordedEvents,
  type TestApp,
  type TestDatabase,
} from '@gam/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { USERS_MIGRATIONS } from '../src/migrations.ts';
import { UsersApi } from '../src/transport/api/users.api.ts';
import { UsersIdentityResolver } from '../src/transport/api/users-identity.resolver.ts';
import { UsersModule } from '../src/users.module.ts';

/** The users module over HTTP, on a real database, with logins resolved by the module itself. */
describe('users over HTTP', () => {
  let db: TestDatabase;
  let api: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS, USERS_MIGRATIONS] });
    api = await createTestApp({
      database: db,
      modules: [UsersModule],
      identities: { imports: [UsersModule], useExisting: UsersIdentityResolver },
    });
  });

  afterAll(async () => {
    await api?.close();
    await db?.dispose();
  });

  beforeEach(() => db.truncate('users.users', 'events.events'));

  const login = (subject: string, email = `${subject}@example.com`) =>
    api.bearer(subject, { email, emailVerified: true });

  async function register(subject: string, email?: string) {
    const response = await api.inject({
      method: 'POST',
      url: '/v1/users',
      headers: await login(subject, email),
      payload: { fullName: subject },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; email: string | null };
  }

  const makeAdmin = (id: string) =>
    db.pool.query(`update users.users set roles = '{admin}' where id = $1`, [id]);

  it('registers a login, then acts as its user; the email comes from the token', async () => {
    const response = await api.inject({
      method: 'POST',
      url: '/v1/users',
      headers: await login('ann', 'Ann@Example.com'),
      payload: { fullName: ' Ann ', email: 'someone-else@example.com' },
    });
    expect(response.statusCode).toBe(201);
    const user = response.json();
    expect(user).toMatchObject({ email: 'ann@example.com', fullName: 'Ann', roles: [] });
    expect(response.headers.location).toBe(`/v1/users/${user.id}`);
    const me = await api.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: await login('ann'),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(user.id);
  });

  it('registers once per login', async () => {
    await register('ann');
    const again = await api.inject({
      method: 'POST',
      url: '/v1/users',
      headers: await login('ann'),
      payload: { fullName: 'Again' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('USER_ALREADY_REGISTERED');
  });

  it('keeps concurrent registrations of one email by different logins race-free', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, async (_, n) =>
        api.inject({
          method: 'POST',
          url: '/v1/users',
          headers: await login(`racer-${n}`, 'race@example.com'),
          payload: { fullName: 'Racer' },
        }),
      ),
    );
    expect(outcomes.filter((o) => o.statusCode === 201)).toHaveLength(1);
    for (const outcome of outcomes.filter((o) => o.statusCode !== 201)) {
      expect(outcome.statusCode).toBe(409);
      expect(outcome.json().code).toBe('USER_EMAIL_TAKEN');
    }
  });

  it('lets a user read and rename itself, hides it from others, shows it to admins', async () => {
    const ann = await register('ann');
    const bob = await register('bob');
    const renamed = await api.inject({
      method: 'PATCH',
      url: '/v1/users/me',
      headers: await login('ann'),
      payload: { fullName: 'Ann Lee' },
    });
    expect(renamed.json()).toMatchObject({ id: ann.id, fullName: 'Ann Lee' });
    const hidden = await api.inject({
      method: 'GET',
      url: `/v1/users/${ann.id}`,
      headers: await login('bob'),
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().code).toBe('USER_NOT_FOUND');
    await makeAdmin(bob.id);
    const shown = await api.inject({
      method: 'GET',
      url: `/v1/users/${ann.id.toUpperCase()}`,
      headers: await login('bob'),
    });
    expect(shown.statusCode).toBe(200);
  });

  it('pages users newest first, for admins only, with tokens bound to the list', async () => {
    const admin = await register('admin');
    for (const n of ['a', 'b', 'c']) await register(n);
    const headers = await login('admin');
    const refused = await api.inject({
      method: 'GET',
      url: '/v1/users',
      headers: await login('a'),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('ADMIN_ROLE_REQUIRED');
    await makeAdmin(admin.id);
    const first = (
      await api.inject({ method: 'GET', url: '/v1/users?pageSize=2', headers })
    ).json();
    expect(first.items.map((u: { fullName: string }) => u.fullName)).toEqual(['c', 'b']);
    const second = (
      await api.inject({
        method: 'GET',
        url: `/v1/users?pageSize=2&pageToken=${first.nextPageToken}`,
        headers,
      })
    ).json();
    expect(second.items.map((u: { fullName: string }) => u.fullName)).toEqual(['a', 'admin']);
    expect(second.nextPageToken).toBeNull();
    const crafted = Buffer.from(JSON.stringify({ v: 1, a: "x' or 1=1", f: '[]' })).toString(
      'base64url',
    );
    const bad = await api.inject({ method: 'GET', url: `/v1/users?pageToken=${crafted}`, headers });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('INVALID_PAGE_TOKEN');
  });

  it('deletes a user and its logins, recording UserDeletedEvent with the delete', async () => {
    const ann = await register('ann');
    const bob = await register('bob');
    const refused = await api.inject({
      method: 'DELETE',
      url: `/v1/users/${ann.id}`,
      headers: await login('bob'),
    });
    expect(refused.statusCode).toBe(404);
    expect(await recordedEvents(api)).toEqual([]);
    const deleted = await api.inject({
      method: 'DELETE',
      url: '/v1/users/me',
      headers: await login('ann'),
    });
    expect(deleted.statusCode).toBe(204);
    const [event, ...rest] = await recordedEvents(api);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      type: 'users.v1.UserDeletedEvent',
      producer: 'users',
      aggregateId: ann.id,
      payload: { userId: ann.id },
      requestId: deleted.headers['x-request-id'],
    });
    // The login is gone with its user: the very next request is unregistered.
    const after = await api.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: await login('ann'),
    });
    expect(after.json().code).toBe('USER_NOT_REGISTERED');
    expect(bob.id).toBeDefined();
  });

  it('applies a role change to the next request', async () => {
    const ann = await register('ann');
    const headers = await login('ann');
    expect((await api.inject({ method: 'GET', url: '/v1/users', headers })).statusCode).toBe(403);
    await makeAdmin(ann.id);
    expect((await api.inject({ method: 'GET', url: '/v1/users', headers })).statusCode).toBe(200);
  });

  it('rejects invalid input with the invalid fields', async () => {
    const response = await api.inject({
      method: 'POST',
      url: '/v1/users',
      headers: await login('x'),
      payload: { fullName: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().errors.map((e: { field: string }) => e.field)).toEqual(['fullName']);
    await register('valid');
    const badId = await api.inject({
      method: 'GET',
      url: '/v1/users/not-a-uuid',
      headers: await login('valid'),
    });
    expect(badId.statusCode).toBe(400);
  });

  it('tells other modules whether the acting user still exists, and only that user', async () => {
    const ann = await register('ann');
    const users = api.get(UsersApi);
    await expect(users.stillExists(userActor(ann.id))).resolves.toBe(true);
    await expect(
      users.stillExists(userActor('01900000-0000-7000-8000-0000000000ff')),
    ).resolves.toBe(false);
    await expect(
      api.get(UnitOfWork).run(() => users.stillExists(adminActor(ann.id))),
    ).rejects.toBeInstanceOf(CrossModuleCallInTransactionError);
  });
});
