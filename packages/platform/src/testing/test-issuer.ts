import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWK, type JWTPayload, SignJWT } from 'jose';

export const TEST_AUDIENCE = 'gam-api';

export interface TokenOptions {
  readonly sub: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  /** Seconds until expiry; negative for an expired token. Default 300. */
  readonly expiresIn?: number;
  readonly audience?: string;
  readonly issuer?: string;
  readonly extraClaims?: JWTPayload;
  readonly header?: Record<string, unknown>;
}

export interface TestIssuer {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly userinfoUri: string;
  /** JWKS fetches served so far. */
  readonly fetches: number;
  token(options: TokenOptions): Promise<string>;
  /** A new signing key; the old public key stays published. */
  rotate(): Promise<void>;
  /** While down, the JWKS and userinfo endpoints answer 503. */
  setDown(down: boolean): void;
  /** Overrides what userinfo returns for a subject. */
  setUserinfo(sub: string, claims: Record<string, unknown>): void;
  close(): Promise<void>;
}

interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

async function newKey(n: number): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const kid = `test-key-${n}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    kid,
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' },
  };
}

/**
 * A minimal OIDC provider on a free port: JWKS, userinfo and token minting, so tests run
 * the real token verification and key fetching (rotation, outages, cooldowns).
 */
export async function createTestIssuer(): Promise<TestIssuer> {
  const keys: SigningKey[] = [await newKey(1)];
  const userinfo = new Map<string, Record<string, unknown>>();
  let down = false;
  let fetches = 0;
  const current = () => keys[keys.length - 1] as SigningKey;

  const server: Server = createServer((request, response) => {
    const send = (status: number, body?: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (down) return send(503);
    if (request.url === '/jwks.json') {
      fetches += 1;
      return send(200, { keys: keys.map((key) => key.publicJwk) });
    }
    if (request.url === '/userinfo') {
      const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
      const claims = JSON.parse(
        Buffer.from(token.split('.')[1] ?? '', 'base64url').toString() || '{}',
      ) as JWTPayload;
      return send(
        200,
        userinfo.get(String(claims.sub)) ?? {
          sub: claims.sub,
          email: claims.email,
          email_verified: claims.email_verified,
        },
      );
    }
    return send(404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${port}`;

  return {
    issuer,
    jwksUri: `${issuer}/jwks.json`,
    userinfoUri: `${issuer}/userinfo`,
    get fetches() {
      return fetches;
    },
    async token(options) {
      const now = Math.floor(Date.now() / 1_000);
      const key = current();
      // extraClaims go last, so a test can override any standard claim (iat, nbf, ...).
      return new SignJWT({
        iss: options.issuer ?? issuer,
        aud: options.audience ?? TEST_AUDIENCE,
        sub: options.sub,
        iat: now,
        exp: now + (options.expiresIn ?? 300),
        ...(options.email === undefined ? {} : { email: options.email }),
        ...(options.emailVerified === undefined ? {} : { email_verified: options.emailVerified }),
        ...options.extraClaims,
      })
        .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: 'at+jwt', ...options.header })
        .sign(key.privateKey);
    },
    async rotate() {
      keys.push(await newKey(keys.length + 1));
    },
    setDown(value) {
      down = value;
    },
    setUserinfo(sub, claims) {
      userinfo.set(sub, claims);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
