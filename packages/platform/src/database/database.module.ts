import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { CONFIG, type DatabaseConfig } from '../config/config.ts';
import { APP_NAME } from '../platform/tokens.ts';
import { DRIZZLE, PG_POOL } from './tokens.ts';

export function createPool(config: DatabaseConfig, applicationName: string): pg.Pool {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: applicationName,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: config.DB_STATEMENT_TIMEOUT_MS * 2,
  });
}

/**
 * One pg Pool and one Drizzle instance per process, shared by every module (each keeps
 * to its own Postgres schema). The pool closes after the HTTP server has drained.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [CONFIG, APP_NAME],
      useFactory: (config: DatabaseConfig, appName: string) => {
        const pool = createPool(config, appName);
        const logger = new Logger('PgPool');
        // An idle client error is emitted on the pool; unhandled it would crash the process.
        pool.on('error', (error) => logger.error(`idle client error: ${error.message}`));
        return pool;
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => drizzle({ client: pool }),
    },
  ],
  exports: [PG_POOL, DRIZZLE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
