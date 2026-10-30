import { type DynamicModule, Inject, Module } from '@nestjs/common';
import { z } from 'zod';
import { authConfigSchema, checkAuthConfig } from '../auth/auth.config.ts';
import { eventsConfigSchema } from '../events/config.ts';

/** DI token of the parsed, typed configuration object. Inject with {@link InjectConfig}. */
export const CONFIG = Symbol('CONFIG');

/** `constructor(@InjectConfig() private readonly config: Config)` */
export const InjectConfig = (): ParameterDecorator => Inject(CONFIG);

const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/** The HTTP server: where it listens, TLS, CORS, limits, docs. */
export const httpConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: logLevel.default('info'),
  LOG_PRETTY: z.stringbool().default(false),
  /** Bind address. 127.0.0.1 locally; 0.0.0.0 in containers. */
  HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(8443),
  /** Serve HTTPS (HTTP/2 + HTTP/1.1). Disable only behind a TLS-terminating proxy. */
  TLS_ENABLED: z.stringbool().default(true),
  TLS_CERT_FILE: z.string().default('../../.certs/dev-cert.pem'),
  TLS_KEY_FILE: z.string().default('../../.certs/dev-key.pem'),
  /** Comma-separated browser origins allowed by CORS; empty = no cross-origin access. */
  CORS_ORIGINS: z.string().default(''),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  /**
   * Longest a request may take, from routing through body upload and handler to the reply;
   * past it the API answers 504 REQUEST_TIMEOUT. Capped: Node fires timers longer than
   * 2^31-1 ms at once, which would time every request out.
   */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(30_000),
  /**
   * Which proxies' X-Forwarded-* to trust (Fastify's trustProxy), so `request.ip`, which the
   * rate limiter keys on, is the client's address as your proxy saw it: `false` (none: no
   * proxy in front), or a comma-separated list of the proxies' addresses or CIDRs (or
   * `loopback`, `linklocal`, `uniquelocal`). `true` trusts every hop, so a client chooses
   * its own address with X-Forwarded-For: only behind a proxy that overwrites the header.
   * A hop count is refused: Fastify cannot check the nearest peer with one.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((value, ctx): boolean | string[] => {
      const trimmed = value.trim();
      if (trimmed === 'false' || trimmed === '') return false;
      if (trimmed === 'true') return true;
      const proxies = trimmed.split(',').map((entry) => entry.trim());
      const proxy = /^(?:[0-9a-fA-F:.]+(?:\/\d{1,3})?|loopback|linklocal|uniquelocal)$/;
      if (!/^\d+$/.test(trimmed) && proxies.every((entry) => proxy.test(entry))) return proxies;
      ctx.addIssue({
        code: 'custom',
        message:
          "must be false, true, or a comma-separated list of the proxies' addresses or CIDRs (Fastify does not trust a hop count)",
      });
      return z.NEVER;
    }),
  /** Serve /docs (Scalar) and /openapi.json. Default: on, except when NODE_ENV=production. */
  DOCS_ENABLED: z.stringbool().optional(),
});

/** The one Postgres database every module keeps its schema in. */
export const databaseConfigSchema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  /**
   * Below the shortest request deadline a client is likely to use, so a slow statement or
   * lock wait ends as DATABASE_TIMEOUT (503) instead of holding a connection until the
   * request's own deadline.
   */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(1_500),
});

/**
 * Everything the platform reads from the environment. An app extends it with its own
 * variables, then applies {@link withPlatformChecks}:
 *
 *   export const ConfigSchema = withPlatformChecks(platformConfigSchema.extend({ ... }));
 */
export const platformConfigSchema = z.object({
  ...httpConfigSchema.shape,
  ...databaseConfigSchema.shape,
  ...authConfigSchema.shape,
  ...eventsConfigSchema.shape,
});

export type HttpConfig = z.output<typeof httpConfigSchema>;
export type DatabaseConfig = z.output<typeof databaseConfigSchema>;
export type PlatformConfig = z.output<typeof platformConfigSchema>;

/** The cross-field rules of the platform's variables (identity-provider URLs, JWKS timings). */
export function withPlatformChecks<S extends z.ZodType<PlatformConfig>>(schema: S) {
  return schema.superRefine((config, ctx) => checkAuthConfig(config, ctx));
}

/** Whether /docs and /openapi.json are served. */
export function docsEnabled(config: HttpConfig): boolean {
  return config.DOCS_ENABLED ?? config.NODE_ENV !== 'production';
}

/**
 * Parses and validates environment variables. Throws one readable error listing
 * every problem, so a misconfigured app fails at boot instead of at first use.
 */
export function parseConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.output<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid configuration:\n${problems}`);
}

@Module({})
export class ConfigModule {
  /** Parses lazily (at DI time), so tests can set process.env before compiling the module. */
  static forRoot(schema: z.ZodType): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: CONFIG, useFactory: () => parseConfig(schema) }],
      exports: [CONFIG],
    };
  }
}
