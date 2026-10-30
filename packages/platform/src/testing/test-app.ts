import type { IdentityActor, Role } from '@gam/kernel';
import type { Abstract, InjectionToken, ModuleMetadata, Type } from '@nestjs/common';
import { MiddlewareBuilder } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AccessRoutes } from '../auth/access-routes.ts';
import { IdentityResolver, type ResolvedUser } from '../auth/identity-resolver.ts';
import { parseConfig, platformConfigSchema, withPlatformChecks } from '../config/config.ts';
import { configureApp, createAdapter } from '../http/bootstrap.ts';
import { type IdentitiesOption, PlatformModule } from '../platform/platform.module.ts';
import { expectListedOpenEndpoints } from './public-endpoints.ts';
import {
  createTestIssuer,
  TEST_AUDIENCE,
  type TestIssuer,
  type TokenOptions,
} from './test-issuer.ts';

/** The parts of a light-my-request response the tests use. */
export interface InjectResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | number | undefined>;
  readonly body: string;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted structurally in tests
  json(): any;
}

const identityKey = ({ issuer, subject }: { issuer: string; subject: string }) =>
  `${issuer}\n${subject}`;

/** Identity mapping held in memory: the default in tests, so any user id can act. */
export class InMemoryIdentityResolver extends IdentityResolver {
  readonly users = new Map<string, ResolvedUser>();

  async resolve(identity: IdentityActor): Promise<ResolvedUser | null> {
    return this.users.get(identityKey(identity)) ?? null;
  }

  register(identity: { issuer: string; subject: string }, user: ResolvedUser): void {
    this.users.set(identityKey(identity), user);
  }

  forgetUser(userId: string): void {
    for (const [key, user] of this.users) if (user.userId === userId) this.users.delete(key);
  }
}

export interface TestApp {
  readonly app: NestFastifyApplication;
  /** The identity provider the app trusts (a local JWKS server). */
  readonly issuer: TestIssuer;
  /** The in-memory identity mapping; undefined with real identities. */
  readonly identities: InMemoryIdentityResolver | undefined;
  inject(options: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    payload?: object;
    headers?: Record<string, string>;
  }): Promise<InjectResponse>;
  /** Authorization header with a token of the test issuer for login `sub`. */
  bearer(sub: string, options?: Omit<TokenOptions, 'sub'>): Promise<Record<string, string>>;
  /** Authorization header of a registered user (a fresh login mapped to `userId`; in-memory identities only). */
  as(userId: string, roles?: readonly Role[]): Promise<Record<string, string>>;
  get<T>(token: Type<T> | Abstract<T>): T;
  get<T>(token: InjectionToken): T;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** The database to run on (a TestDatabase, or any URL). */
  readonly database: { readonly url: string };
  /**
   * The app's own root module (it imports PlatformModule itself), or the feature modules
   * to mount on a test platform.
   */
  readonly app?: Type;
  readonly modules?: ModuleMetadata['imports'];
  /**
   * How logins become users. Default: in memory (`as(userId)` acts as anyone). Pass the
   * users module's resolver (or `'app'` with `app`) to resolve them from the database.
   */
  readonly identities?: Exclude<IdentitiesOption, { readonly useValue: IdentityResolver }> | 'app';
  /** Providers replaced by test doubles, e.g. another module's public API. */
  readonly overrides?: ReadonlyMap<InjectionToken, unknown>;
  readonly env?: Record<string, string>;
  /**
   * Compare the open routes with security/public-endpoints.json (whole-app tests): what
   * the AuthGuard enforces is what the reviewed list says.
   */
  readonly checkPublicEndpoints?: boolean;
}

/** Platform files allowed to add routes, hooks and middleware outside controllers. */
const RAW_HTTP_FILES = new Set(['http/bootstrap', 'http/openapi']);
/** Routes outside controllers: the OpenAPI document, and CORS preflight when CORS is on. */
const NON_CONTROLLER_ROUTES = new Set(['GET /openapi.json', 'HEAD /openapi.json', 'OPTIONS *']);
/** A frame in the repository's own code (not node_modules), and the file it is in. */
const OWN_FILE =
  /\/(?:apps|modules|packages|templates)\/[\w.-]+\/(?:src|dist|test)\/([^:)]+)\.(?:ts|js)/;
const PLATFORM_FILE = /\/packages\/platform\/(?:src|dist)\/([^:)]+)\.(?:ts|js)/;
const THIS_FILE = /\/packages\/platform\/(?:src|dist)\/testing\/test-app\.(?:ts|js)/;

/** Stack frames above the caller, this file and Node's own frames left out. */
function callers(): string[] {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 100;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  return stack
    .split('\n')
    .slice(1)
    .filter((frame) => !THIS_FILE.test(frame))
    .filter((frame) => !frame.includes('node:internal') && !frame.includes('(native)'));
}

/** Who made a frame's call: `platform:<file>`, `own:<file>`, `library`, or `unknown`. */
function owner(frame: string): string {
  if (frame.includes('/node_modules/')) return 'library';
  const platform = PLATFORM_FILE.exec(frame);
  if (platform) return `platform:${platform[1]}`;
  const own = OWN_FILE.exec(frame);
  return own ? `own:${own[1]}` : 'unknown';
}

/**
 * Who called a registration method: the repository file that called it, `library` when a
 * package did, or `unknown` when nothing can be named (a call scheduled from a microtask,
 * for instance), which counts as a file other than the allowed two.
 */
function caller(): string {
  return owner(callers()[0] ?? '');
}

/** Who registered a route: Nest's router, a repository file anywhere on the stack, or else. */
function routeOwner(): string {
  const frames = callers();
  if (frames.some((frame) => frame.includes('/@nestjs/core/router/'))) return 'nest';
  for (const frame of frames) {
    const by = owner(frame);
    if (by !== 'library' && by !== 'unknown') return by;
  }
  return frames.some((frame) => frame.includes('/node_modules/')) ? 'library' : 'unknown';
}

/** What the HTTP server got besides controller routes while the app started. */
interface Registrations {
  readonly routes: { readonly route: string; readonly by: string }[];
  readonly hooks: { readonly what: string; readonly by: string }[];
}

/** The app being created; Nest middleware (consumer.apply) is recorded into it. */
let recording: Registrations | undefined;
const apply = MiddlewareBuilder.prototype.apply;
MiddlewareBuilder.prototype.apply = function (this: MiddlewareBuilder, ...middleware) {
  recording?.hooks.push({ what: 'Nest middleware (consumer.apply)', by: caller() });
  return apply.apply(this, middleware);
};

/** Wraps `target[name]` so each call is recorded with the code that made it. */
function track(target: object, name: string, into: Registrations): void {
  const original = (target as Record<string, unknown>)[name];
  if (typeof original !== 'function') return;
  (target as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
    into.hooks.push({ what: `${name}(${String(args[0])})`, by: caller() });
    return (original as (...rest: unknown[]) => unknown).apply(this, args);
  };
}

/** Records every route, hook, plugin, handler and middleware the server gets, and who added it. */
function recordRegistrations(adapter: ReturnType<typeof createAdapter>): Registrations {
  const registrations: Registrations = { routes: [], hooks: [] };
  const fastify = adapter.getInstance();
  fastify.addHook('onRoute', (route: { method: string | string[]; url: string }) => {
    const by = routeOwner();
    for (const verb of [route.method].flat()) {
      registrations.routes.push({ route: `${verb} ${route.url}`, by });
    }
  });
  for (const name of ['addHook', 'register', 'setNotFoundHandler', 'setErrorHandler']) {
    track(fastify, name, registrations);
  }
  track(adapter, 'use', registrations);
  // @fastify/middie adds the instance's own `use` while Nest starts: wrap it on arrival.
  const decorate = fastify.decorate;
  (fastify as unknown as Record<string, unknown>).decorate = function (
    this: unknown,
    ...args: unknown[]
  ) {
    const result: unknown = Reflect.apply(decorate, this, args);
    if (args[0] === 'use') track(fastify, 'use', registrations);
    return result;
  };
  return registrations;
}

/**
 * Fails unless every route is a controller route (so the AuthGuard sees it) or one of the
 * known exceptions, and nothing but packages and the platform's http/bootstrap.ts and
 * http/openapi.ts added hooks, plugins, handlers or middleware (ADR-0004). Runs once
 * Fastify is ready, so registrations deferred to its boot are seen too.
 */
function expectOnlyGuardedRoutes(seen: Registrations): void {
  const allowedFrom = (by: string) =>
    by === 'nest' ||
    by === 'library' ||
    (by.startsWith('platform:') && RAW_HTTP_FILES.has(by.slice('platform:'.length)));
  const stray = seen.routes.filter(
    ({ route, by }) => by !== 'nest' && !(NON_CONTROLLER_ROUTES.has(route) && allowedFrom(by)),
  );
  const hooks = seen.hooks.filter(({ by }) => !allowedFrom(by));
  if (stray.length > 0 || hooks.length > 0) {
    throw new Error(
      [
        'the app serves requests outside its controllers, so the AuthGuard never sees them (ADR-0004):',
        ...stray.map(({ route, by }) => `  route ${route} (from ${by})`),
        ...hooks.map(({ what, by }) => `  ${what} (from ${by})`),
      ].join('\n'),
    );
  }
}

let issuer: Promise<TestIssuer> | undefined;
let logins = 0;

/**
 * Boots the real HTTP app (production adapter, configuration, AuthGuard and filters, TLS
 * off, event delivery driven by hand) on a test database, behind a local identity
 * provider. Fails unless every route is served by a controller (ADR-0004), and with
 * `checkPublicEndpoints` unless the open routes are exactly those
 * security/public-endpoints.json lists.
 *
 *   const app = await createTestApp({ database: db, modules: [HousesModule],
 *     overrides: new Map([[UsersApi, fakeUsers]]) });
 *   await app.inject({ method: 'POST', url: '/v1/houses', headers: await app.as(userId), payload });
 */
export async function createTestApp(options: TestAppOptions): Promise<TestApp> {
  if ((options.app === undefined) === (options.modules === undefined)) {
    throw new TypeError('createTestApp takes either app or modules');
  }
  // One identity provider per test process.
  issuer ??= createTestIssuer();
  const idp = await issuer;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
    TLS_ENABLED: 'false',
    DATABASE_URL: options.database.url,
    AUTH_ISSUERS: JSON.stringify([
      {
        issuer: idp.issuer,
        audience: TEST_AUDIENCE,
        jwksUri: idp.jwksUri,
        userinfoUri: idp.userinfoUri,
      },
    ]),
    AUTH_JWKS_UNKNOWN_KID_COOLDOWN_S: '0',
    EVENTS_AUTOSTART: 'false',
    ...options.env,
  });
  const config = parseConfig(withPlatformChecks(platformConfigSchema));
  const identities = options.identities;
  if (identities === 'app' ? !options.app : identities !== undefined && !options.modules) {
    throw new TypeError("identities: 'app' goes with app, a resolver with modules");
  }
  const memory = identities === undefined ? new InMemoryIdentityResolver() : undefined;
  const imports = options.app
    ? [options.app]
    : [
        PlatformModule.forRoot({
          name: 'test',
          config: withPlatformChecks(platformConfigSchema),
          identities: memory
            ? { useValue: memory }
            : (identities as Exclude<typeof identities, 'app' | undefined>),
        }),
        ...(options.modules ?? []),
      ];
  let builder = Test.createTestingModule({ imports });
  if (options.app && memory) builder = builder.overrideProvider(IdentityResolver).useValue(memory);
  for (const [token, fake] of options.overrides ?? []) {
    builder = builder.overrideProvider(token).useValue(fake);
  }
  const moduleRef = await builder.compile();
  const adapter = createAdapter(config);
  const registrations = recordRegistrations(adapter);
  const app = moduleRef.createNestApplication<NestFastifyApplication>(adapter);
  const fastify = app.getHttpAdapter().getInstance();
  recording = registrations;
  try {
    configureApp(app, config);
    await app.init();
    await fastify.ready();
    if (options.checkPublicEndpoints) expectListedOpenEndpoints(app.get(AccessRoutes).open);
    expectOnlyGuardedRoutes(registrations);
  } catch (error) {
    await app.close();
    throw error;
  } finally {
    recording = undefined;
  }
  const bearer = async (sub: string, tokenOptions: Omit<TokenOptions, 'sub'> = {}) => ({
    authorization: `Bearer ${await idp.token({ sub, ...tokenOptions })}`,
  });
  return {
    app,
    issuer: idp,
    identities: memory,
    inject: (request) => fastify.inject(request),
    bearer,
    as: async (userId, roles = []) => {
      if (!memory)
        throw new Error('as(userId) needs in-memory identities; register a login instead');
      logins += 1;
      const subject = `login-${logins}`;
      memory.register({ issuer: idp.issuer, subject }, { userId, roles });
      return bearer(subject);
    },
    get: <T>(token: InjectionToken) => app.get<T>(token as Type<T>),
    close: () => app.close(),
  };
}
