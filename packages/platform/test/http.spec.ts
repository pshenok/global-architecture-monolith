import { ThrottlerException } from '@nestjs/throttler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  docsEnabled,
  parseConfig,
  platformConfigSchema,
  withPlatformChecks,
} from '../src/config/config.ts';
import { PLATFORM_MIGRATIONS } from '../src/database/platform-migrations.ts';
import { toProblemDetails } from '../src/http/problem-details.ts';
import { createTestApp, type TestApp } from '../src/testing/test-app.ts';
import { createTestDatabase, type TestDatabase } from '../src/testing/test-database.ts';
import { ProbeModule } from './probe.ts';

const USER_ID = '01900000-0000-7000-8000-000000000001';

describe('the HTTP API (AuthGuard, problem details, headers, docs)', () => {
  let db: TestDatabase;
  let api: TestApp;
  let ann: Record<string, string>;

  beforeAll(async () => {
    db = await createTestDatabase({ migrations: [PLATFORM_MIGRATIONS] });
    api = await createTestApp({ database: db, modules: [ProbeModule] });
    ann = await api.as(USER_ID);
  });

  afterAll(async () => {
    await api?.close();
    await db?.dispose();
  });

  const get = (url: string, headers?: Record<string, string>) =>
    api.inject({ method: 'GET', url, ...(headers ? { headers } : {}) });

  describe('authentication', () => {
    it('answers a protected route without a token with 401 and WWW-Authenticate', async () => {
      const response = await get('/probe/user');
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer realm="gam"');
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(response.json()).toMatchObject({ status: 401, code: 'AUTH_TOKEN_MISSING' });
    });

    it('answers a bad or expired token with 401 invalid_token', async () => {
      for (const [headers, code] of [
        [{ authorization: 'Bearer not.a.jwt' }, 'AUTH_TOKEN_INVALID'],
        [{ authorization: 'Basic YW5uOnB3' }, 'AUTH_TOKEN_INVALID'],
        [await api.bearer('ann', { expiresIn: -120 }), 'AUTH_TOKEN_EXPIRED'],
        [await api.bearer('ann', { audience: 'some-client' }), 'AUTH_TOKEN_INVALID'],
      ] as const) {
        const response = await get('/probe/user', headers);
        expect(response.statusCode).toBe(401);
        expect(response.headers['www-authenticate']).toBe(
          'Bearer realm="gam", error="invalid_token"',
        );
        expect(response.json().code).toBe(code);
      }
    });

    it('requires a registered user on user routes', async () => {
      const response = await get('/probe/user', await api.bearer('newcomer'));
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('USER_NOT_REGISTERED');
    });

    it('acts as the user the login belongs to', async () => {
      const response = await get('/probe/user', ann);
      expect(response.statusCode).toBe(200);
      expect(response.json().actor).toEqual({ kind: 'user', userId: USER_ID, roles: [] });
    });

    it('lets only admins through admin routes', async () => {
      const refused = await get('/probe/admin', ann);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe('ADMIN_ROLE_REQUIRED');
      const admin = await get('/probe/admin', await api.as(USER_ID, ['admin']));
      expect(admin.statusCode).toBe(200);
      expect(admin.json().actor.roles).toEqual(['admin']);
    });

    it('applies a role change or a deletion on the very next request', async () => {
      const headers = await api.as('01900000-0000-7000-8000-0000000000b2');
      expect((await get('/probe/user', headers)).statusCode).toBe(200);
      api.identities?.forgetUser('01900000-0000-7000-8000-0000000000b2');
      expect((await get('/probe/user', headers)).json().code).toBe('USER_NOT_REGISTERED');
    });

    it('gives identity routes the login, with the email the provider verified', async () => {
      const response = await api.inject({
        method: 'POST',
        url: '/probe/register',
        headers: await api.bearer('newcomer', { email: 'Ann@Example.com', emailVerified: true }),
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().actor).toEqual({
        kind: 'identity',
        issuer: api.issuer.issuer,
        subject: 'newcomer',
        email: 'Ann@Example.com',
      });
      const unverified = await api.inject({
        method: 'POST',
        url: '/probe/register',
        headers: await api.bearer('newcomer', { email: 'a@b.io', emailVerified: false }),
      });
      expect(unverified.statusCode).toBe(403);
      expect(unverified.json().code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('serves public routes anonymously, even with a valid token, but never with a bad one', async () => {
      expect((await get('/probe/public')).json().actor).toEqual({ kind: 'anonymous' });
      expect((await get('/probe/public', ann)).json().actor).toEqual({ kind: 'anonymous' });
      const bad = await get('/probe/public', { authorization: 'Bearer forged.token.value' });
      expect(bad.statusCode).toBe(401);
    });

    it('keeps public routes and probes up during an IdP outage; new keys get 503', async () => {
      api.issuer.setDown(true);
      try {
        await api.issuer.rotate(); // tokens now carry a kid the app has not fetched
        const headers = await api.bearer('login-during-outage');
        expect((await get('/probe/public', headers)).statusCode).toBe(200);
        const user = await get('/probe/user', headers);
        expect(user.statusCode).toBe(503);
        expect(user.json().code).toBe('IDENTITY_PROVIDER_UNAVAILABLE');
        for (const url of ['/healthz', '/readyz']) {
          const probe = await get(url, { authorization: 'Basic not-even-bearer' });
          expect(probe.statusCode).toBe(200);
        }
      } finally {
        api.issuer.setDown(false);
      }
    });
  });

  describe('errors', () => {
    it('answers a domain error by its kind, with its reason, message and metadata', async () => {
      const response = await get('/probe/conflict', ann);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'that probe is taken',
        instance: '/probe/conflict',
        code: 'PROBE_TAKEN',
        metadata: { probeId: 'p-1' },
      });
      expect(response.json().requestId).toBe(response.headers['x-request-id']);
    });

    it('translates database conflicts and timeouts nobody translated', async () => {
      const deadlock = await get('/probe/deadlock', ann);
      expect(deadlock.statusCode).toBe(409);
      expect(deadlock.json().code).toBe('TRANSACTION_CONFLICT');
      const timeout = await get('/probe/statement-timeout', ann);
      expect(timeout.statusCode).toBe(503);
      expect(timeout.json().code).toBe('DATABASE_TIMEOUT');
      expect(timeout.json()).not.toHaveProperty('detail');
    });

    it('never exposes an unexpected error', async () => {
      const response = await get('/probe/boom', ann);
      expect(response.statusCode).toBe(500);
      expect(response.json().code).toBe('INTERNAL');
      expect(response.body).not.toContain('hunter2');
      expect(response.body).not.toContain('secret');
    });

    it('rejects invalid input with 400 and the invalid fields', async () => {
      const query = await get('/probe/page?size=99', ann);
      expect(query.statusCode).toBe(400);
      expect(query.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(query.json().errors[0].field).toBe('size');
      const body = await api.inject({
        method: 'POST',
        url: '/probe/notes',
        headers: ann,
        payload: { text: '' },
      });
      expect(body.statusCode).toBe(400);
      expect(body.json().errors[0].field).toBe('text');
    });

    it('returns problem+json for unknown routes', async () => {
      const response = await get('/v1/nope');
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });
  });

  it('echoes a safe x-request-id, replaces an unsafe one, and sends security headers', async () => {
    const response = await get('/healthz', { 'x-request-id': 'req-abc-123' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('req-abc-123');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("script-src 'self';");
    const unsafe = await get('/healthz', { 'x-request-id': 'bad id\r\nx: 1' });
    expect(unsafe.headers['x-request-id']).not.toContain('bad id');
  });

  it('relaxes the CSP for the /docs page only', async () => {
    const docs = await get('/docs');
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-security-policy']).toContain('https://cdn.jsdelivr.net');
    const other = await get('/v1/nope');
    expect(other.headers['content-security-policy']).not.toContain('cdn.jsdelivr.net');
  });

  it('publishes an OpenAPI document with bearer security on every non-public operation', async () => {
    const document = (await get('/openapi.json')).json();
    expect(document.security).toEqual([{ bearer: [] }]);
    expect(document.paths['/probe/public'].get.security).toEqual([]);
    expect(document.paths['/probe/user'].get.responses).toHaveProperty('401');
    expect(document.paths['/probe/user'].get.responses).toHaveProperty('403');
    expect(document.paths).not.toHaveProperty('/healthz');
    expect(JSON.stringify(document)).not.toContain('x-gam-public');
  });
});

describe('platform config', () => {
  const ConfigSchema = withPlatformChecks(platformConfigSchema);
  const issuers = (jwksUri: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify([{ issuer: 'https://idp.example', audience: 'gam-api', jwksUri, ...extra }]);
  const env = {
    DATABASE_URL: 'postgresql://gam:gam@localhost:5432/gam',
    AUTH_ISSUERS: issuers('https://idp.example/jwks.json'),
  };

  it('disables the docs by default in production only', () => {
    expect(docsEnabled(parseConfig(ConfigSchema, { ...env, NODE_ENV: 'production' }))).toBe(false);
    expect(docsEnabled(parseConfig(ConfigSchema, { ...env, NODE_ENV: 'development' }))).toBe(true);
    expect(
      docsEnabled(
        parseConfig(ConfigSchema, { ...env, NODE_ENV: 'production', DOCS_ENABLED: 'true' }),
      ),
    ).toBe(true);
  });

  it('requires https identity providers, except loopback outside production', () => {
    const local = { ...env, AUTH_ISSUERS: issuers('http://127.0.0.1:9090/jwks.json') };
    expect(() => parseConfig(ConfigSchema, { ...local, NODE_ENV: 'development' })).not.toThrow();
    expect(() => parseConfig(ConfigSchema, { ...local, NODE_ENV: 'production' })).toThrow(
      /must use https/,
    );
    const remote = { ...env, AUTH_ISSUERS: issuers('http://idp.example/jwks.json') };
    expect(() => parseConfig(ConfigSchema, remote)).toThrow(/must use https/);
  });

  it('refuses a max-stale window shorter than two refresh intervals', () => {
    expect(() =>
      parseConfig(ConfigSchema, {
        ...env,
        AUTH_JWKS_REFRESH_S: '600',
        AUTH_JWKS_MAX_STALE_S: '900',
      }),
    ).toThrow(/AUTH_JWKS_MAX_STALE_S/);
  });

  it('never accepts symmetric or unsigned algorithms, nor a non-JSON issuer list', () => {
    for (const algorithm of ['HS256', 'none']) {
      const config = {
        ...env,
        AUTH_ISSUERS: issuers('https://idp.example/jwks.json', { algorithms: [algorithm] }),
      };
      expect(() => parseConfig(ConfigSchema, config)).toThrow(/AUTH_ISSUERS/);
    }
    expect(() => parseConfig(ConfigSchema, { ...env, AUTH_ISSUERS: 'not json' })).toThrow(
      /JSON array/,
    );
  });

  it('requires a postgres URL', () => {
    expect(() => parseConfig(ConfigSchema, { ...env, DATABASE_URL: 'mysql://x' })).toThrow(
      /DATABASE_URL/,
    );
  });
});

describe('toProblemDetails', () => {
  it('maps throttling to 429', () => {
    expect(toProblemDetails(new ThrottlerException(), '/v1/users', 'r1')).toMatchObject({
      status: 429,
      code: 'TOO_MANY_REQUESTS',
    });
  });

  it('never exposes unexpected errors', () => {
    expect(toProblemDetails(new Error('secret'), '/x', 'r1')).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      instance: '/x',
      requestId: 'r1',
      code: 'INTERNAL',
    });
  });
});
