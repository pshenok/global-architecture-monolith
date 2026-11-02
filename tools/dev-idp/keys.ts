import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  compactVerify,
  createLocalJWKSet,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from 'jose';
import { CERTS_DIR, readRegistry } from '../lib.ts';
import type { Identity } from './store.ts';

export const port = readRegistry().devIdp.port;
export const issuer = `http://127.0.0.1:${port}`;
/** The API's audience: access tokens minted over JSON default to it. */
export const API_AUDIENCE = 'gam-api';
const MAX_KEYS = 3;
const KEYS_FILE = `${CERTS_DIR}/dev-idp.jwk.json`;
const ID_TOKEN_TTL_S = 600;
export const MAX_ACCESS_TTL_S = 3_600;

type StoredKey = JWK & { kid: string };

async function newKey(): Promise<StoredKey> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const kid = `dev-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
  return { ...(await exportJWK(privateKey)), kid, alg: 'ES256', use: 'sig' };
}

function save(keys: StoredKey[]): void {
  mkdirSync(dirname(KEYS_FILE), { recursive: true });
  writeFileSync(`${KEYS_FILE}.tmp`, JSON.stringify({ keys }), { mode: 0o600 });
  renameSync(`${KEYS_FILE}.tmp`, KEYS_FILE);
}

let keys: StoredKey[] = existsSync(KEYS_FILE)
  ? (JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as { keys: StoredKey[] }).keys
  : [];
if (keys.length === 0) {
  keys = [await newKey()];
  save(keys);
}

export const publicKeys = () => keys.map(({ d: _private, ...publicJwk }) => publicJwk);

/** A new signing key; the old public keys stay published (at most MAX_KEYS). */
export async function rotate(): Promise<string | undefined> {
  keys = [...keys, await newKey()].slice(-MAX_KEYS);
  save(keys);
  return keys[keys.length - 1]?.kid;
}

async function sign(claims: JWTPayload, typ: string): Promise<string> {
  const current = keys[keys.length - 1] as StoredKey;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: current.kid, typ })
    .sign(await importJWK(current, 'ES256'));
}

const nowS = () => Math.floor(Date.now() / 1_000);

const emailClaims = (identity: Pick<Identity, 'email' | 'emailVerified'>) =>
  identity.email === undefined
    ? {}
    : { email: identity.email, email_verified: identity.emailVerified };

/** An RFC 9068 access token for the API (`typ: at+jwt`). */
export function accessToken(options: {
  identity: Identity;
  audience: string;
  scope: readonly string[];
  clientId?: string;
}): Promise<string> {
  const iat = nowS();
  return sign(
    {
      iss: issuer,
      aud: options.audience,
      sub: options.identity.sub,
      iat,
      exp: iat + Math.min(options.identity.accessTtlS, MAX_ACCESS_TTL_S),
      scope: options.scope.join(' '),
      jti: randomUUID(),
      ...(options.clientId === undefined ? {} : { client_id: options.clientId }),
      ...emailClaims(options.identity),
    },
    'at+jwt',
  );
}

/** An OIDC ID token for the client (never accepted by the API: wrong audience and typ). */
export function idToken(options: {
  identity: Identity;
  clientId: string;
  nonce: string;
  sid: string;
  authTime: number;
}): Promise<string> {
  const iat = nowS();
  return sign(
    {
      iss: issuer,
      aud: options.clientId,
      sub: options.identity.sub,
      iat,
      exp: iat + ID_TOKEN_TTL_S,
      auth_time: options.authTime,
      nonce: options.nonce,
      sid: options.sid,
      ...emailClaims(options.identity),
    },
    'JWT',
  );
}

/** Verifies an access token this IdP issued (for /userinfo). */
export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, createLocalJWKSet({ keys: publicKeys() }), {
    issuer,
    typ: 'at+jwt',
  });
  return payload;
}

/**
 * Verifies the signature and issuer of an ID token this IdP issued, ignoring its expiry:
 * end-session accepts an expired `id_token_hint` (OIDC RP-Initiated Logout 1.0).
 */
export async function verifyIdTokenHint(token: string): Promise<JWTPayload> {
  await compactVerify(token, createLocalJWKSet({ keys: publicKeys() }), {
    algorithms: ['ES256'],
  });
  const payload = decodeJwt(token);
  if (payload.iss !== issuer) throw new Error('id_token_hint from another issuer');
  return payload;
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
