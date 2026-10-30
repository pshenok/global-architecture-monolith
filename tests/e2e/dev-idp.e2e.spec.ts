import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import { api, bearer, IDP_URL, unique } from './client.ts';

/**
 * The dev IdP's authorization code flow, as a browser client (global-architecture-web's
 * BFF) uses it: authorize, sign-in form, code + PKCE, refresh rotation, end-session.
 * Driven by fetch; the client is the one registered in modules.json devIdp.clients.
 */

interface Client {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
}
const client = (
  JSON.parse(readFileSync(new URL('../../modules.json', import.meta.url), 'utf8')) as {
    devIdp: { clients: Client[] };
  }
).devIdp.clients[0] as Client;
const REDIRECT_URI = client.redirectUris[0] as string;
const basic = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`;

const b64url = (bytes: Buffer) => bytes.toString('base64url');
const challengeOf = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

function authorizeUrl(overrides: Record<string, string | undefined> = {}): string {
  const params: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    scope: 'openid email offline_access',
    state: 'state-1',
    nonce: 'nonce-1',
    code_challenge_method: 'S256',
    ...overrides,
  };
  const url = new URL(`${IDP_URL}/authorize`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  redirect: 'manual' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

/** Opens the sign-in form and submits it; returns the 303's Location. */
async function signIn(
  sub: string,
  options: { verifier: string; accessTtl?: number; scope?: string },
): Promise<URL> {
  const page = await fetch(
    authorizeUrl({
      code_challenge: challengeOf(options.verifier),
      ...(options.scope ? { scope: options.scope } : {}),
    }),
  );
  expect(page.status).toBe(200);
  expect(page.headers.get('content-security-policy')).toContain(
    "form-action 'self' http://localhost:9300",
  );
  const html = await page.text();
  const txn = html.match(/name="txn" value="([^"]+)"/)?.[1];
  expect(txn).toBeTruthy();
  const submitted = await fetch(
    `${IDP_URL}/authorize`,
    form({
      txn: txn as string,
      action: 'sign-in',
      sub,
      email: `${sub}@example.com`,
      email_verified: 'true',
      access_ttl: String(options.accessTtl ?? 300),
    }),
  );
  expect(submitted.status).toBe(303);
  return new URL(submitted.headers.get('location') as string);
}

async function tokenRequest(fields: Record<string, string>, auth = basic) {
  const response = await fetch(`${IDP_URL}/token`, {
    ...form(fields),
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: auth },
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

async function login(sub: string) {
  const verifier = b64url(randomBytes(32));
  const callback = await signIn(sub, { verifier });
  return tokenRequest({
    grant_type: 'authorization_code',
    code: callback.searchParams.get('code') as string,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
}

describe('dev IdP code flow (e2e)', () => {
  it('advertises the code flow in its discovery document', async () => {
    const discovery = (await (
      await fetch(`${IDP_URL}/.well-known/openid-configuration`)
    ).json()) as Record<string, unknown>;
    expect(discovery).toMatchObject({
      issuer: IDP_URL,
      authorization_endpoint: `${IDP_URL}/authorize`,
      end_session_endpoint: `${IDP_URL}/end-session`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('signs a login in, and its access token works on the API like any other', async () => {
    const sub = unique('web');
    const verifier = b64url(randomBytes(32));
    const callback = await signIn(sub, { verifier });
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get('state')).toBe('state-1');
    expect(callback.searchParams.get('iss')).toBe(IDP_URL);

    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code') as string,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ token_type: 'Bearer', expires_in: 300 });
    expect(tokens.body.refresh_token).toBeTruthy();
    const idClaims = decodeJwt(tokens.body.id_token as string);
    expect(idClaims).toMatchObject({ sub, aud: client.clientId, nonce: 'nonce-1' });
    expect(decodeJwt(tokens.body.access_token as string)).toMatchObject({
      sub,
      aud: 'gam-api',
      client_id: client.clientId,
    });

    const access = bearer(tokens.body.access_token as string);
    expect((await api('GET', '/v1/users/me', undefined, access)).body).toMatchObject({
      code: 'USER_NOT_REGISTERED',
    });
    expect((await api('POST', '/v1/users', { fullName: 'Web' }, access)).status).toBe(201);
    expect((await api('GET', '/v1/users/me', undefined, access)).body).toMatchObject({
      email: `${sub}@example.com`,
    });
    // The ID token is for the client, never for the API.
    const withIdToken = await api(
      'GET',
      '/v1/users/me',
      undefined,
      bearer(tokens.body.id_token as string),
    );
    expect(withIdToken.status).toBe(401);
  });

  it('issues no refresh token without offline_access', async () => {
    const verifier = b64url(randomBytes(32));
    const callback = await signIn(unique('online'), { verifier, scope: 'openid email' });
    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code') as string,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(tokens.status).toBe(200);
    expect(tokens.body.refresh_token).toBeUndefined();
  });

  it('refuses a wrong verifier, a replayed code and a bad client secret', async () => {
    const verifier = b64url(randomBytes(32));
    const callback = await signIn(unique('pkce'), { verifier });
    const code = callback.searchParams.get('code') as string;
    const grant = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI };

    const wrongSecret = `Basic ${Buffer.from(`${client.clientId}:nope`).toString('base64')}`;
    expect((await tokenRequest({ ...grant, code_verifier: verifier }, wrongSecret)).status).toBe(
      401,
    );
    const wrong = await tokenRequest({ ...grant, code_verifier: b64url(randomBytes(32)) });
    expect(wrong).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    // A code is single use, even when the first attempt failed.
    const replay = await tokenRequest({ ...grant, code_verifier: verifier });
    expect(replay).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('refuses unregistered redirect URIs and plain PKCE before showing a form', async () => {
    const foreign = await fetch(
      authorizeUrl({ redirect_uri: 'http://localhost:9999/cb', code_challenge: 'x'.repeat(43) }),
      { redirect: 'manual' },
    );
    expect(foreign.status).toBe(400);
    expect(foreign.headers.get('location')).toBeNull();

    const plain = await fetch(
      authorizeUrl({ code_challenge_method: 'plain', code_challenge: 'x'.repeat(43) }),
      { redirect: 'manual' },
    );
    expect(plain.status).toBe(303);
    const location = new URL(plain.headers.get('location') as string);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('iss')).toBe(IDP_URL);
  });

  it('rotates refresh tokens, and a reused one revokes the login', async () => {
    const first = await login(unique('rotate'));
    const rotated = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: first.body.refresh_token as string,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(first.body.refresh_token);
    expect(rotated.body.id_token).toBeUndefined();

    const reuse = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: first.body.refresh_token as string,
    });
    expect(reuse).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    const afterReuse = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: rotated.body.refresh_token as string,
    });
    expect(afterReuse).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('ends the session: back to a registered URI, refresh family revoked', async () => {
    const tokens = await login(unique('logout'));
    const target = client.postLogoutRedirectUris[0] as string;
    const url = new URL(`${IDP_URL}/end-session`);
    url.searchParams.set('id_token_hint', tokens.body.id_token as string);
    url.searchParams.set('post_logout_redirect_uri', target);
    url.searchParams.set('state', 'bye');
    const ended = await fetch(url, { redirect: 'manual' });
    expect(ended.status).toBe(303);
    expect(ended.headers.get('location')).toBe(`${target}?state=bye`);

    const refreshed = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.body.refresh_token as string,
    });
    expect(refreshed).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });

    url.searchParams.set('post_logout_redirect_uri', 'https://evil.example/');
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(400);
  });
});
