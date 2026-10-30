import { PLATFORM_MIGRATIONS } from '@gam/platform';
import {
  createTestApp,
  createTestDatabase,
  type TestApp,
  type TestDatabase,
} from '@gam/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_ITEMS_MIGRATIONS } from '../src/migrations.ts';
import { SampleItemsModule } from '../src/sample-items.module.ts';

const OWNER = '01900000-0000-7000-8000-0000000000a1';
const STRANGER = '01900000-0000-7000-8000-0000000000b1';

/**
 * Through the real HTTP stack: Fastify -> AuthGuard -> controller -> use case -> Drizzle
 * -> Postgres (a database of its own with the real migrations).
 */
describe('sample items over HTTP', () => {
  let db: TestDatabase;
  let api: TestApp;
  let asOwner: Record<string, string>;

  beforeAll(async () => {
    db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS, SAMPLE_ITEMS_MIGRATIONS] });
    api = await createTestApp({ database: db, modules: [SampleItemsModule] });
  });

  afterAll(async () => {
    await api?.close();
    await db?.dispose();
  });

  beforeEach(async () => {
    await db.truncate('sample_items.sample_items');
    asOwner = await api.as(OWNER);
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers?: Record<string, string>,
    payload?: object,
  ) =>
    api.inject({ method, url, ...(headers ? { headers } : {}), ...(payload ? { payload } : {}) });
  const create = async (name: string) =>
    (await call('POST', '/v1/sample-items', asOwner, { name })).json().id as string;

  it('creates, reads, updates and deletes', async () => {
    const created = await call('POST', '/v1/sample-items', asOwner, {
      name: ' Lamp ',
      description: 'warm',
    });
    expect(created.statusCode).toBe(201);
    const item = created.json();
    expect(item).toMatchObject({ name: 'Lamp', description: 'warm', ownerId: OWNER });
    expect(created.headers.location).toBe(`/v1/sample-items/${item.id}`);
    expect((await call('GET', `/v1/sample-items/${item.id}`, asOwner)).json().name).toBe('Lamp');
    const updated = await call('PATCH', `/v1/sample-items/${item.id}`, asOwner, {
      description: 'cold',
    });
    expect(updated.json()).toMatchObject({ name: 'Lamp', description: 'cold' });
    expect((await call('DELETE', `/v1/sample-items/${item.id}`, asOwner)).statusCode).toBe(204);
    expect((await call('GET', `/v1/sample-items/${item.id}`, asOwner)).statusCode).toBe(404);
  });

  it('maps the unique name constraint to 409 with a reason', async () => {
    await create('Lamp');
    const taken = await call('POST', '/v1/sample-items', asOwner, { name: 'Lamp' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().code).toBe('SAMPLE_ITEM_NAME_TAKEN');
  });

  it('rejects malformed input with the invalid fields', async () => {
    const badId = await call('GET', '/v1/sample-items/not-a-uuid', asOwner);
    expect(badId.statusCode).toBe(400);
    const badName = await call('POST', '/v1/sample-items', asOwner, { name: '' });
    expect(badName.json().errors[0].field).toBe('name');
  });

  it('pages with opaque tokens, newest first', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) await create(name);
    const names = (page: { items: { name: string }[] }) => page.items.map((i) => i.name);
    const first = (await call('GET', '/v1/sample-items?pageSize=2', asOwner)).json();
    expect(names(first)).toEqual(['e', 'd']);
    const second = (
      await call('GET', `/v1/sample-items?pageSize=2&pageToken=${first.nextPageToken}`, asOwner)
    ).json();
    expect(names(second)).toEqual(['c', 'b']);
    const last = (
      await call('GET', `/v1/sample-items?pageSize=2&pageToken=${second.nextPageToken}`, asOwner)
    ).json();
    expect(names(last)).toEqual(['a']);
    expect(last.nextPageToken).toBeNull();
    const garbage = await call('GET', '/v1/sample-items?pageToken=garbage', asOwner);
    expect(garbage.statusCode).toBe(400);
  });

  it('serializes concurrent partial updates without losing either change', async () => {
    const id = await create('Lamp');
    await Promise.all([
      call('PATCH', `/v1/sample-items/${id}`, asOwner, { name: 'Desk lamp' }),
      call('PATCH', `/v1/sample-items/${id}`, asOwner, { description: 'adjustable' }),
    ]);
    expect((await call('GET', `/v1/sample-items/${id}`, asOwner)).json()).toMatchObject({
      name: 'Desk lamp',
      description: 'adjustable',
    });
  });

  /**
   * The five access cases every module keeps (ADR-0004, gam-testing). When you reshape
   * the template, adapt them; do not delete them.
   */
  describe('access', () => {
    it('1. refuses a request without a signed-in user', async () => {
      const response = await call('GET', '/v1/sample-items');
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_TOKEN_MISSING');
    });

    it('2. answers another user 404, as if the item did not exist', async () => {
      const id = await create('Lamp');
      const stranger = await api.as(STRANGER);
      for (const response of [
        await call('GET', `/v1/sample-items/${id}`, stranger),
        await call('PATCH', `/v1/sample-items/${id}`, stranger, { name: 'Mine now' }),
        await call('DELETE', `/v1/sample-items/${id}`, stranger),
      ]) {
        expect(response.statusCode).toBe(404);
        expect(response.json().code).toBe('SAMPLE_ITEM_NOT_FOUND');
      }
    });

    it("3. lets an admin read and change anyone's item", async () => {
      const id = await create('Lamp');
      const admin = await api.as(STRANGER, ['admin']);
      expect((await call('GET', `/v1/sample-items/${id}`, admin)).statusCode).toBe(200);
      const changed = await call('PATCH', `/v1/sample-items/${id}`, admin, {
        description: 'by admin',
      });
      expect(changed.json().description).toBe('by admin');
    });

    it("4. shows a stranger an empty list, and rejects the owner's page tokens", async () => {
      await create('a');
      await create('b');
      const first = (await call('GET', '/v1/sample-items?pageSize=1', asOwner)).json();
      const stranger = await api.as(STRANGER);
      expect((await call('GET', '/v1/sample-items', stranger)).json().items).toHaveLength(0);
      const replayed = await call(
        'GET',
        `/v1/sample-items?pageSize=1&pageToken=${first.nextPageToken}`,
        stranger,
      );
      expect(replayed.statusCode).toBe(400);
    });

    it('5. refuses a login that has not registered as a user', async () => {
      const response = await call('GET', '/v1/sample-items', await api.bearer('newcomer'));
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('USER_NOT_REGISTERED');
    });
  });
});
