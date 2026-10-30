import { DependencyUnavailableError, UnauthenticatedError } from '@gam/kernel';
import { decodeJwt, decodeProtectedHeader, errors, type JWTPayload, jwtVerify } from 'jose';
import type { IssuerConfig } from './auth.config.ts';
import { IdpKeySet } from './idp-key-set.ts';

/** Larger tokens are refused before any parsing (a cheap guard against abuse). */
const MAX_TOKEN_BYTES = 8 * 1_024;
/** Claims that only ID tokens carry: an ID token is never accepted as an access token. */
const ID_TOKEN_CLAIMS = ['nonce', 'at_hash', 'c_hash'] as const;

export interface VerifiedAccessToken {
  readonly token: string;
  readonly issuer: IssuerConfig;
  /** The provider's id of the user (`sub`). */
  readonly subject: string;
  readonly claims: JWTPayload;
}

export const tokenMissing = () =>
  new UnauthenticatedError('AUTH_TOKEN_MISSING', 'this endpoint needs a bearer token');
export const tokenInvalid = () =>
  new UnauthenticatedError('AUTH_TOKEN_INVALID', 'the bearer token is invalid');
export const tokenExpired = () =>
  new UnauthenticatedError('AUTH_TOKEN_EXPIRED', 'the bearer token has expired');

/** Verifies OIDC access tokens of the configured identity providers. */
export class AccessTokenVerifier {
  constructor(
    private readonly issuers: ReadonlyMap<string, { config: IssuerConfig; keys: IdpKeySet }>,
    private readonly clockToleranceSeconds: number,
  ) {}

  async verify(token: string): Promise<VerifiedAccessToken> {
    if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw tokenInvalid();
    let issuerName: unknown;
    let kid: unknown;
    try {
      issuerName = decodeJwt(token).iss;
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw tokenInvalid();
    }
    // The unverified issuer only selects which keys to verify with; jwtVerify checks it again.
    const issuer = typeof issuerName === 'string' ? this.issuers.get(issuerName) : undefined;
    if (!issuer || typeof kid !== 'string') throw tokenInvalid();
    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(token, issuer.keys.getKey, {
        issuer: issuer.config.issuer,
        audience: issuer.config.audience,
        algorithms: [...issuer.config.algorithms],
        clockTolerance: this.clockToleranceSeconds,
        requiredClaims: ['exp', 'iat', 'sub'],
        ...(issuer.config.requiredTyp ? { typ: issuer.config.requiredTyp } : {}),
      }));
    } catch (error) {
      if (error instanceof DependencyUnavailableError) throw error;
      if (error instanceof errors.JWTExpired) throw tokenExpired();
      throw tokenInvalid();
    }
    const subject = claims.sub as string;
    const issuedInFuture = (claims.iat as number) > Date.now() / 1_000 + this.clockToleranceSeconds;
    const idToken = ID_TOKEN_CLAIMS.some((claim) => claim in claims);
    if (subject.length === 0 || subject.length > 255 || issuedInFuture || idToken) {
      throw tokenInvalid();
    }
    return { token, issuer: issuer.config, subject, claims };
  }
}

/** The bearer token of an Authorization header; undefined when there is none. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (Array.isArray(header)) throw tokenInvalid();
  const match = /^Bearer[ ]+([A-Za-z0-9._~+/=-]+)[ ]*$/i.exec(header);
  if (!match) throw tokenInvalid();
  return match[1];
}
