import { afterAll, describe, expect, it } from 'vitest';
import { PLATFORM_MIGRATIONS } from '../src/database/platform-migrations.ts';
import { createTestApp, type TestApp } from '../src/testing/test-app.ts';
import { createTestDatabase } from '../src/testing/test-database.ts';

/** /readyz against a real database that is there, then gone, and one that never was. */
describe('readiness', () => {
  const apps: TestApp[] = [];

  afterAll(async () => {
    for (const app of apps) await app.close();
  });

  it('is not ready until the database has answered once', async () => {
    const url = new URL(
      process.env.TEST_DATABASE_URL ?? 'postgresql://gam:gam@localhost:5432/gam_test',
    );
    url.pathname = '/gam_no_such_database';
    const api = await createTestApp({ database: { url: url.toString() }, modules: [] });
    apps.push(api);
    const response = await api.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'starting', database: 'unavailable' });
    expect((await api.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('becomes ready, then stays ready and reports degraded when the database goes away', async () => {
    const db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS] });
    const api = await createTestApp({ database: db, modules: [] });
    apps.push(api);
    // The identity provider's keys load in the background after boot.
    await expect
      .poll(async () => (await api.inject({ method: 'GET', url: '/readyz' })).json())
      .toEqual({ status: 'ok', database: 'ok', identityProvider: 'ok' });
    await db.dispose();
    const degraded = await api.inject({ method: 'GET', url: '/readyz' });
    expect(degraded.statusCode).toBe(200);
    expect(degraded.json()).toMatchObject({ status: 'degraded', database: 'unavailable' });
  });
});
