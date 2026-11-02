import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DevIdpClient } from '../lib.ts';
import { authenticateClient } from './clients.ts';
import { readBody, sendJson, singleParams } from './http.ts';
import {
  API_AUDIENCE,
  accessToken,
  idToken,
  MAX_ACCESS_TTL_S,
  randomToken,
  sha256,
} from './keys.ts';
import { codes, FAMILY_TTL_MS, type Family, families, refreshTokens } from './store.ts';

/**
 * POST /token.
 * - JSON body: mints an access token for any subject (pnpm dev:token, the API's e2e).
 * - Form body: the OAuth grants `authorization_code` (with PKCE) and `refresh_token`.
 *   Refresh tokens rotate on every use; presenting a rotated one revokes the family,
 *   strictly (no grace window), so refresh races in a client surface locally.
 */

const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

const oauthError = (response: ServerResponse, status: number, error: string, description: string) =>
  sendJson(response, status, { error, error_description: description });

function revoke(sid: string): void {
  const family = families.get(sid);
  if (family) family.revoked = true;
}

function issueRefreshToken(sid: string, family: Family): string {
  const token = randomToken();
  const remainingMs = family.createdAt + FAMILY_TTL_MS - Date.now();
  refreshTokens.set(sha256(token), { sid, active: true }, remainingMs);
  return token;
}

async function mint(response: ServerResponse, body: Record<string, unknown>): Promise<void> {
  if (typeof body.sub !== 'string' || !body.sub) {
    return oauthError(response, 400, 'invalid_request', 'sub required');
  }
  const ttlS = Math.min(Number(body.ttlS ?? 900), MAX_ACCESS_TTL_S);
  const token = await accessToken({
    identity: {
      sub: body.sub,
      email: typeof body.email === 'string' ? body.email : undefined,
      emailVerified: body.emailVerified !== false,
      accessTtlS: ttlS,
    },
    audience: typeof body.audience === 'string' ? body.audience : API_AUDIENCE,
    scope: ['openid', 'email'],
  });
  sendJson(response, 200, {
    access_token: token,
    token_type: 'Bearer',
    expires_in: Number(body.ttlS ?? 900),
  });
}

async function authorizationCode(
  response: ServerResponse,
  client: DevIdpClient,
  form: Map<string, string>,
): Promise<void> {
  const code = codes.get(form.get('code') ?? '');
  if (!code || code.clientId !== client.clientId) {
    return oauthError(response, 400, 'invalid_grant', 'unknown or expired code');
  }
  if (code.used) {
    // RFC 6749 section 4.1.2: a replayed code revokes what it issued.
    revoke(code.sid);
    return oauthError(response, 400, 'invalid_grant', 'code already used');
  }
  code.used = true;
  if (form.get('redirect_uri') !== code.redirectUri) {
    return oauthError(response, 400, 'invalid_grant', 'redirect_uri differs');
  }
  const verifier = form.get('code_verifier') ?? '';
  const challenge = Buffer.from(sha256(verifier));
  const expected = Buffer.from(code.codeChallenge);
  if (
    !CODE_VERIFIER.test(verifier) ||
    challenge.length !== expected.length ||
    !timingSafeEqual(challenge, expected)
  ) {
    return oauthError(response, 400, 'invalid_grant', 'code_verifier does not match');
  }

  const family: Family = {
    clientId: client.clientId,
    scope: code.scope,
    identity: code.identity,
    createdAt: Date.now(),
    revoked: false,
  };
  families.set(code.sid, family, FAMILY_TTL_MS);
  const offline = code.scope.includes('offline_access');
  sendJson(response, 200, {
    access_token: await accessToken({
      identity: code.identity,
      audience: client.audience,
      scope: code.scope,
      clientId: client.clientId,
    }),
    token_type: 'Bearer',
    expires_in: code.identity.accessTtlS,
    id_token: await idToken({
      identity: code.identity,
      clientId: client.clientId,
      nonce: code.nonce,
      sid: code.sid,
      authTime: code.authTime,
    }),
    scope: code.scope.join(' '),
    ...(offline ? { refresh_token: issueRefreshToken(code.sid, family) } : {}),
  });
}

async function refresh(
  response: ServerResponse,
  client: DevIdpClient,
  form: Map<string, string>,
): Promise<void> {
  const stored = refreshTokens.get(sha256(form.get('refresh_token') ?? ''));
  const family = stored ? families.get(stored.sid) : undefined;
  if (!stored || !family || family.revoked || family.clientId !== client.clientId) {
    return oauthError(response, 400, 'invalid_grant', 'unknown, expired or revoked refresh token');
  }
  if (!stored.active) {
    revoke(stored.sid);
    return oauthError(response, 400, 'invalid_grant', 'refresh token reused; session revoked');
  }
  stored.active = false;
  sendJson(response, 200, {
    access_token: await accessToken({
      identity: family.identity,
      audience: client.audience,
      scope: family.scope,
      clientId: client.clientId,
    }),
    token_type: 'Bearer',
    expires_in: family.identity.accessTtlS,
    scope: family.scope.join(' '),
    refresh_token: issueRefreshToken(stored.sid, family),
  });
}

export async function token(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const text = await readBody(request);
  if (!String(request.headers['content-type']).startsWith('application/x-www-form-urlencoded')) {
    return mint(response, text ? (JSON.parse(text) as Record<string, unknown>) : {});
  }
  const form = singleParams(new URLSearchParams(text));
  const client = authenticateClient(request, form);
  if (!client) {
    response.setHeader('www-authenticate', 'Basic realm="dev-idp"');
    return oauthError(response, 401, 'invalid_client', 'client authentication failed');
  }
  switch (form.get('grant_type') ?? '') {
    case 'authorization_code':
      return authorizationCode(response, client, form);
    case 'refresh_token':
      return refresh(response, client, form);
    default:
      return oauthError(
        response,
        400,
        'unsupported_grant_type',
        'authorization_code or refresh_token',
      );
  }
}

/** Revokes a login's refresh family (end-session). */
export { revoke };
