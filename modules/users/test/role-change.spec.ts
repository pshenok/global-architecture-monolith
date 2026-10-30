import { createTestDatabase, type TestDatabase } from '@gam/platform/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { USERS_MIGRATIONS } from '../src/migrations.ts';
import { changedBy, changeRole, parseRoleChange } from '../src/ops/role-change.ts';

const USER_ID = '01900000-0000-7000-8000-000000000001';

describe('role CLI', () => {
  it('parses grant|revoke <userId> <role> [--by <name>]', () => {
    expect(parseRoleChange(['grant', USER_ID, 'admin'])).toEqual({
      action: 'grant',
      userId: USER_ID,
      role: 'admin',
    });
    expect(parseRoleChange(['revoke', USER_ID, 'admin', '--by', 'ann'])).toEqual({
      action: 'revoke',
      userId: USER_ID,
      role: 'admin',
      by: 'ann',
    });
    for (const args of [
      [],
      ['promote', USER_ID, 'admin'],
      ['grant', USER_ID],
      ['grant', USER_ID, 'admin', '--by'],
      ['grant', USER_ID, 'admin', '--by', ' '],
      ['grant', USER_ID, 'admin', '--as', 'ann'],
      ['grant', USER_ID, 'admin', '--by', 'ann', 'extra'],
    ]) {
      expect(parseRoleChange(args), args.join(' ')).toBeUndefined();
    }
  });

  it('names who made the change without ever throwing', () => {
    expect(changedBy('ann', () => 'nonroot')).toBe('ann');
    expect(changedBy(undefined, () => 'kp')).toBe('kp');
    const noPasswdEntry = () => {
      throw new Error('uv_os_get_passwd returned ENOENT');
    };
    expect(changedBy(undefined, noPasswdEntry)).toMatch(/^uid /);
  });

  describe('changeRole', () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await createTestDatabase({ migrations: [USERS_MIGRATIONS] });
    });
    afterAll(() => db?.dispose());
    beforeEach(async () => {
      await db.truncate('users.users');
      await db.pool.query(
        `insert into users.users (id, email, full_name, roles, created_at, updated_at)
         values ($1, 'ann@example.com', 'Ann', '{}', now(), now())`,
        [USER_ID],
      );
    });

    const change = (action: 'grant' | 'revoke', role = 'admin', userId = USER_ID) =>
      changeRole(drizzle({ client: db.pool }), { action, userId, role });

    it('grants and revokes, idempotently', async () => {
      expect(await change('grant')).toEqual(['admin']);
      expect(await change('grant')).toEqual(['admin']);
      expect(await change('revoke')).toEqual([]);
      expect(await change('revoke')).toEqual([]);
      const { rows } = await db.pool.query<{ roles: string[] }>(
        'select roles from users.users where id = $1',
        [USER_ID],
      );
      expect(rows[0]?.roles).toEqual([]);
    });

    it('refuses an unknown role and an unknown user, changing nothing', async () => {
      await expect(change('grant', 'superuser')).rejects.toThrow('unknown role superuser');
      await expect(
        change('grant', 'admin', '01900000-0000-7000-8000-0000000000ff'),
      ).rejects.toThrow('not found');
      const { rows } = await db.pool.query<{ roles: string[] }>('select roles from users.users');
      expect(rows[0]?.roles).toEqual([]);
    });
  });
});
