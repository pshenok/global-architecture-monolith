/**
 * A local OpenID Connect provider for development and the e2e suite (ADR-0004): the
 * API trusts it like any real IdP, so the stack needs no identity infrastructure.
 * It signs whatever subject it is asked for, which is exactly why it refuses to run
 * in production and only listens on loopback.
 *
 *   GET  /.well-known/openid-configuration, /jwks.json
 *   GET  /userinfo                       (Bearer: a token it issued)
 *   POST /token  {"sub":"alice","email":"a@x.io","emailVerified":true,"ttlS":900}
 *   POST /rotate                         new signing key; old public keys stay published
 *
 * Keys: .certs/dev-idp.jwk.json. Port: modules.json devIdp.port.
 *   pnpm dev:token <sub> [--email a@x.io] [--unverified] [--ttl 900]
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from 'jose';
import { CERTS_DIR, readRegistry } from './lib.ts';

if (process.env.NODE_ENV === 'production') {
  console.error('dev-idp signs any subject it is asked for; it never runs in production');
  process.exit(1);
}

const port = readRegistry().devIdp.port;
const issuer = `http://127.0.0.1:${port}`;
const AUDIENCE = 'gam-api';
const MAX_KEYS = 3;
const KEYS_FILE = `${CERTS_DIR}/dev-idp.jwk.json`;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

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

const publicKeys = () => keys.map(({ d: _private, ...publicJwk }) => publicJwk);

async function issue(body: Record<string, unknown>): Promise<string> {
  const current = keys[keys.length - 1] as StoredKey;
  const ttl = Math.min(Number(body.ttlS ?? 900), 3_600);
  const now = Math.floor(Date.now() / 1_000);
  const claims: JWTPayload = {
    iss: issuer,
    aud: typeof body.audience === 'string' ? body.audience : AUDIENCE,
    sub: String(body.sub),
    iat: now,
    exp: now + ttl,
    scope: 'openid email',
  };
  if (typeof body.email === 'string') {
    claims.email = body.email;
    claims.email_verified = body.emailVerified !== false;
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: current.kid, typ: 'at+jwt' })
    .sign(await importJWK(current, 'ES256'));
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let text = '';
    request.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      if (text.length > 4_096) reject(new Error('body too large'));
    });
    request.on('end', () => {
      try {
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

const send = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};

const server = createServer(async (request, response) => {
  // DNS rebinding guard: a browser page cannot reach this server under another name.
  if (!ALLOWED_HOSTS.has(request.headers.host ?? '')) return send(response, 421, { error: 'host' });
  try {
    const route = `${request.method} ${request.url?.split('?')[0]}`;
    switch (route) {
      case 'GET /.well-known/openid-configuration':
        return send(response, 200, {
          issuer,
          jwks_uri: `${issuer}/jwks.json`,
          userinfo_endpoint: `${issuer}/userinfo`,
          token_endpoint: `${issuer}/token`,
          id_token_signing_alg_values_supported: ['ES256'],
        });
      case 'GET /jwks.json':
        return send(response, 200, { keys: publicKeys() });
      case 'GET /userinfo': {
        const token = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const { payload } = await jwtVerify(token, createLocalJWKSet({ keys: publicKeys() }), {
          issuer,
        });
        return send(response, 200, {
          sub: payload.sub,
          ...(payload.email
            ? { email: payload.email, email_verified: payload.email_verified }
            : {}),
        });
      }
      case 'POST /token': {
        const body = await readBody(request);
        if (typeof body.sub !== 'string' || !body.sub) {
          return send(response, 400, {
            error: 'invalid_request',
            error_description: 'sub required',
          });
        }
        const token = await issue(body);
        return send(response, 200, {
          access_token: token,
          token_type: 'Bearer',
          expires_in: Number(body.ttlS ?? 900),
        });
      }
      case 'POST /rotate': {
        keys = [...keys, await newKey()].slice(-MAX_KEYS);
        save(keys);
        return send(response, 200, { kid: keys[keys.length - 1]?.kid });
      }
      default:
        return send(response, 404, { error: 'not_found' });
    }
  } catch (error) {
    return send(response, 400, { error: 'invalid_request', error_description: String(error) });
  }
});

server.listen(port, '127.0.0.1', () => console.log(`dev-idp issuing tokens as ${issuer}`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
