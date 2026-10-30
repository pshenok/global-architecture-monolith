import { Controller, Get, Module, Post } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ACCESS_POLICY, Access } from '../src/auth/access.ts';
import { accessRoutesOf } from '../src/auth/access-routes.ts';
import { PLATFORM_MIGRATIONS } from '../src/database/platform-migrations.ts';
import { createTestApp } from '../src/testing/test-app.ts';
import { createTestDatabase } from '../src/testing/test-database.ts';

describe('@Access and the boot record of route policies', () => {
  it('records every route, and lists the open ones', () => {
    @Controller('a')
    class Routes {
      @Get('one')
      @Access.public('a reason')
      one() {}

      @Post('two')
      @Access.identity()
      two() {}

      @Get('three')
      @Access.admin()
      three() {}

      helper() {}
    }
    const { policies, open } = accessRoutesOf([{ type: Routes }]);
    expect(open).toEqual([
      { member: 'Routes.one', access: 'public', reason: 'a reason' },
      { member: 'Routes.two', access: 'identity', reason: 'login without a user' },
    ]);
    const table = policies.get(Routes);
    expect(table?.get(Routes.prototype.three)).toEqual({ kind: 'admin' });
    expect(table?.has(Routes.prototype.helper)).toBe(false);
  });

  it('refuses a route without a policy, a policy on the class, and two policies', () => {
    @Controller('b')
    class Undeclared {
      @Get()
      list() {}
    }
    expect(() => accessRoutesOf([{ type: Undeclared }])).toThrow(
      /routes without an @Access policy: Undeclared.list/,
    );

    @Controller('c')
    class OnClass {
      @Get()
      @Access.user()
      list() {}
    }
    Reflect.defineMetadata(ACCESS_POLICY, { kind: 'public', reason: 'x' }, OnClass);
    expect(() => accessRoutesOf([{ type: OnClass }])).toThrow(/not on OnClass/);

    expect(() => {
      class Twice {
        @Access.user()
        @Access.admin()
        list() {}
      }
      return Twice;
    }).toThrow(/more than one @Access policy/);
    expect(() => Access.public('  ')).toThrow(/needs a reason/);
  });

  it('keeps bound copies of a route, but never a copy two routes share', () => {
    @Controller('d')
    class Bound {
      @Get('one')
      @Access.public('open')
      one() {}

      @Get('two')
      @Access.user()
      two() {}
    }
    const instance = new Bound() as unknown as Record<string, unknown>;
    const copy = Bound.prototype.one.bind(instance);
    instance.one = copy;
    instance.two = copy;
    const { policies } = accessRoutesOf([{ type: Bound, instance }]);
    expect(policies.get(Bound)?.has(copy)).toBe(false);
  });

  it('fails app boot on a route without a policy', async () => {
    @Controller('e')
    class Forgotten {
      @Get()
      list() {}
    }
    @Module({ controllers: [Forgotten] })
    class ForgottenModule {}
    const db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS] });
    try {
      await expect(createTestApp({ database: db, modules: [ForgottenModule] })).rejects.toThrow(
        /Forgotten.list/,
      );
    } finally {
      await db.dispose();
    }
  });
});
