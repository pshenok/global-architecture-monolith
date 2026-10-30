import { PLATFORM_MIGRATIONS } from '@gam/platform';
import {
  createTestApp,
  createTestDatabase,
  type TestApp,
  type TestDatabase,
} from '@gam/platform/testing';
import type { InjectionToken } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HouseCatalog } from '../src/application/ports/house-catalog.ts';
import { UserDirectory } from '../src/application/ports/user-directory.ts';
import { BookingsModule } from '../src/bookings.module.ts';
import { BOOKINGS_MIGRATIONS } from '../src/migrations.ts';
import { day, FakeHouseCatalog, FakeUserDirectory, GUEST_ID, HOUSE_ID } from './fakes.ts';

/**
 * Database errors that no repository wraps (here a statement timeout while waiting for a
 * row lock in SELECT ... FOR UPDATE) still reach the client with a precise status.
 */
describe('database errors outside repository translation', () => {
  let db: TestDatabase;
  let api: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS, BOOKINGS_MIGRATIONS] });
    api = await createTestApp({
      database: db,
      modules: [BookingsModule],
      env: { DB_STATEMENT_TIMEOUT_MS: '300' },
      overrides: new Map<InjectionToken, unknown>([
        [UserDirectory, new FakeUserDirectory()],
        [HouseCatalog, new FakeHouseCatalog()],
      ]),
    });
  });

  afterAll(async () => {
    await api?.close();
    await db?.dispose();
  });

  it('answers 503 DATABASE_TIMEOUT when a row lock outlasts the statement timeout', async () => {
    const asGuest = await api.as(GUEST_ID);
    const created = await api.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: asGuest,
      payload: { houseId: HOUSE_ID, checkIn: day(10), checkOut: day(12), guests: 1 },
    });
    const id = created.json().id as string;
    const cancel = () =>
      api.inject({ method: 'POST', url: `/v1/bookings/${id}/cancel`, headers: asGuest });
    const blocker = await db.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select 1 from bookings.bookings where id = $1 for update', [id]);
      const failure = await cancel();
      expect(failure.statusCode).toBe(503);
      expect(failure.json().code).toBe('DATABASE_TIMEOUT');
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
    }
    // The lock is gone, so the same cancel now goes through.
    const cancelled = await cancel();
    expect(cancelled.json()).toMatchObject({ status: 'CANCELLED' });
  });
});
