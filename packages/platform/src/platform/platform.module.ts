import { Clock, IdGenerator, UnitOfWork } from '@gam/kernel';
import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import type { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard.ts';
import { AuthModule } from '../auth/auth.module.ts';
import { IdentityResolver } from '../auth/identity-resolver.ts';
import { CONFIG, ConfigModule, type PlatformConfig } from '../config/config.ts';
import { DatabaseModule } from '../database/database.module.ts';
import { DbContext, DrizzleUnitOfWork } from '../database/db-context.ts';
import { DRIZZLE } from '../database/tokens.ts';
import { EventsCoreModule } from '../events/events.module.ts';
import { HealthController } from '../http/health.controller.ts';
import { loggerParams } from '../logging/logger-params.ts';
import { SystemClock, UuidV7IdGenerator } from './core-providers.ts';
import { ModuleApiCheck } from './module-api.check.ts';
import { APP_NAME } from './tokens.ts';

/** Where the IdentityResolver comes from: the module that owns users, or a test double. */
export type IdentitiesOption =
  | {
      readonly imports?: ModuleMetadata['imports'];
      readonly useExisting: InjectionToken;
    }
  | { readonly useValue: IdentityResolver };

export interface PlatformOptions {
  /** kebab-case name of the app: logs, the database application_name. */
  readonly name: string;
  /** The app's config schema: platformConfigSchema, extended, with withPlatformChecks. */
  readonly config: z.ZodType<PlatformConfig>;
  /** Binds the IdentityResolver the AuthGuard uses. */
  readonly identities: IdentitiesOption;
}

const NAME = /^[a-z][a-z0-9-]*[a-z0-9]$/;

/**
 * Everything the monolith runs on, in one import: config, structured logging, request
 * context, rate limiting, authentication (AuthGuard + the @Access boot record), the
 * database with transactions (DbContext, UnitOfWork), ids, clock, events (registry and
 * dispatcher) and the health routes.
 *
 *   @Module({ imports: [PlatformModule.forRoot({ name: 'api', config: ConfigSchema,
 *     identities: { imports: [UsersModule], useExisting: UsersIdentityResolver } }), ...modules] })
 */
@Module({})
export class PlatformModule {
  static forRoot(options: PlatformOptions): DynamicModule {
    if (!NAME.test(options.name)) {
      throw new TypeError(`app name must be kebab-case, got "${options.name}"`);
    }
    const identities = options.identities;
    const resolver: Provider =
      'useValue' in identities
        ? { provide: IdentityResolver, useValue: identities.useValue }
        : { provide: IdentityResolver, useExisting: identities.useExisting };
    const providers: Provider[] = [
      { provide: APP_NAME, useValue: options.name },
      { provide: IdGenerator, useClass: UuidV7IdGenerator },
      { provide: Clock, useClass: SystemClock },
      DbContext,
      { provide: UnitOfWork, useClass: DrizzleUnitOfWork },
      resolver,
      ModuleApiCheck,
      // Order matters: rate limiting runs before any token cryptography.
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
    ];
    return {
      module: PlatformModule,
      global: true,
      imports: [
        ConfigModule.forRoot(options.config),
        DiscoveryModule,
        LoggerModule.forRootAsync({
          inject: [CONFIG],
          useFactory: (config: PlatformConfig) => loggerParams(options.name, config),
        }),
        // Request context: the Fastify request id becomes the CLS id, which logs and the
        // events a request records carry.
        ClsModule.forRoot({
          global: true,
          middleware: {
            mount: true,
            generateId: true,
            idGenerator: (request: { id?: unknown }) => String(request.id),
          },
          plugins: [
            new ClsPluginTransactional({
              imports: [DatabaseModule],
              adapter: new TransactionalAdapterDrizzleOrm({ drizzleInstanceToken: DRIZZLE }),
            }),
          ],
        }),
        ThrottlerModule.forRootAsync({
          inject: [CONFIG],
          useFactory: (config: PlatformConfig) => ({
            throttlers: [{ name: 'default', ttl: 60_000, limit: config.RATE_LIMIT_PER_MINUTE }],
          }),
        }),
        DatabaseModule,
        AuthModule,
        EventsCoreModule,
        ...('imports' in identities ? (identities.imports ?? []) : []),
      ],
      controllers: [HealthController],
      providers,
      exports: [APP_NAME, IdGenerator, Clock, DbContext, UnitOfWork, IdentityResolver],
    };
  }
}
