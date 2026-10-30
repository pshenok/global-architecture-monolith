import { exportJWK, generateKeyPair, SignJWT, UnsecuredJWT } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AccessTokenVerifier,
  bearerToken,
  type VerifiedAccessToken,
} from '../src/auth/access-token-verifier.ts';
import type { IssuerConfig } from '../src/auth/auth.config.ts';
import { acceptedEmail } from '../src/auth/email-claims.ts';
import { IdpKeySet } from '../src/auth/idp-key-set.ts';
import { createTestIssuer, TEST_AUDIENCE, type TestIssuer } from '../src/testing/test-issuer.ts';

const issuerConfig = (issuer: TestIssuer, overrides: Partial<IssuerConfig> = {}): IssuerConfig => ({
  issuer: issuer.issuer,
  audience: TEST_AUDIENCE,
  jwksUri: issuer.jwksUri,
  algorithms: ['RS256', 'ES256'],
  emailPolicy: 'verified-claim',
  ...overrides,
});

const options = {
  refreshMs: 60_000,
  unknownKidCooldownMs: 60_000,
  maxStaleMs: 600_000,
  timeoutMs: 1_000,
};

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { reason?: string }).reason ?? String(error);
  }
  return 'ok';
}

describe('access tokens', () => {
  let idp: TestIssuer;
  let other: TestIssuer;
  let keySet: IdpKeySet;
  let verifier: AccessTokenVerifier;
  const stops: IdpKeySet[] = [];

  const verifierFor = (
    entries: { issuer: TestIssuer; keySet: IdpKeySet; config?: Partial<IssuerConfig> }[],
  ) =>
    new AccessTokenVerifier(
      new Map(
        entries.map((e) => [
          e.issuer.issuer,
          { config: issuerConfig(e.issuer, e.config), keys: e.keySet },
        ]),
      ),
      30,
    );
  const keySetFor = (issuer: TestIssuer, overrides: Partial<typeof options> = {}) => {
    const set = new IdpKeySet(issuer.jwksUri, { ...options, ...overrides });
    stops.push(set);
    return set;
  };

  beforeAll(async () => {
    idp = await createTestIssuer();
    other = await createTestIssuer();
    keySet = keySetFor(idp);
    await keySet.refresh();
    verifier = verifierFor([{ issuer: idp, keySet }]);
  });

  afterAll(async () => {
    for (const set of stops) set.stop();
    await idp.close();
    await other.close();
  });

  afterEach(() => {
    idp.setDown(false);
  });

  it('accepts a valid access token and returns its subject', async () => {
    const verified = await verifier.verify(await idp.token({ sub: 'auth0|42' }));
    expect(verified.subject).toBe('auth0|42');
    expect(verified.issuer.issuer).toBe(idp.issuer);
  });

  it.each([
    ['another audience (e.g. a client id)', { audience: 'spa-client' }],
    ['an issuer it does not trust', { issuer: 'https://evil.example' }],
    ['an ID token (nonce)', { extraClaims: { nonce: 'n-1' } }],
    ['an iat in the future', { extraClaims: { iat: Math.floor(Date.now() / 1000) + 3600 } }],
    ['a not-yet-valid token', { extraClaims: { nbf: Math.floor(Date.now() / 1000) + 3600 } }],
    ['a huge subject', { sub: 'x'.repeat(256) }],
  ])('rejects %s', async (_name, overrides) => {
    expect(await reason(verifier.verify(await idp.token({ sub: 's1', ...overrides })))).toBe(
      'AUTH_TOKEN_INVALID',
    );
  });

  it('tells expired tokens apart, honouring the clock tolerance', async () => {
    expect(await reason(verifier.verify(await idp.token({ sub: 's1', expiresIn: -120 })))).toBe(
      'AUTH_TOKEN_EXPIRED',
    );
    await expect(
      verifier.verify(await idp.token({ sub: 's1', expiresIn: -10 })),
    ).resolves.toBeDefined();
  });

  it('rejects forged, unsigned, HMAC-confused and kid-less tokens', async () => {
    const valid = await idp.token({ sub: 's1' });
    const [header] = valid.split('.');
    const claims = {
      iss: idp.issuer,
      aud: TEST_AUDIENCE,
      sub: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const { privateKey } = await generateKeyPair('ES256');
    const forged = await new SignJWT(claims)
      .setProtectedHeader(JSON.parse(Buffer.from(header as string, 'base64url').toString()))
      .sign(privateKey);
    const unsigned = new UnsecuredJWT(claims).encode();
    const hmac = await new SignJWT(claims)
      .setProtectedHeader({
        alg: 'HS256',
        kid: JSON.parse(Buffer.from(header as string, 'base64url').toString()).kid,
      })
      .sign(new TextEncoder().encode('public-key-bytes'));
    const noKid = await new SignJWT(claims).setProtectedHeader({ alg: 'ES256' }).sign(privateKey);
    for (const token of [forged, unsigned, hmac, noKid, 'garbage', `${valid}x`]) {
      expect(await reason(verifier.verify(token))).toBe('AUTH_TOKEN_INVALID');
    }
  });

  it('keeps issuers apart even when their kids collide', async () => {
    const otherKeys = keySetFor(other);
    await otherKeys.refresh();
    const both = verifierFor([
      { issuer: idp, keySet },
      { issuer: other, keySet: otherKeys },
    ]);
    const fromOther = await other.token({ sub: 's1' });
    await expect(both.verify(fromOther)).resolves.toMatchObject({
      subject: 's1',
      issuer: { issuer: other.issuer },
    });
    // A token claiming idp's issuer but signed by the other provider's key fails.
    const crossed = await other.token({ sub: 's1', issuer: idp.issuer });
    expect(await reason(both.verify(crossed))).toBe('AUTH_TOKEN_INVALID');
  });

  it('fetches once per cooldown for unknown kids and picks up rotated keys', async () => {
    const rotating = await createTestIssuer();
    try {
      const set = keySetFor(rotating, { unknownKidCooldownMs: 60_000 });
      const verify = verifierFor([{ issuer: rotating, keySet: set }]);
      await set.refresh(); // the boot fetch does not start the unknown-kid cooldown
      await rotating.rotate();
      const before = rotating.fetches;
      await expect(verify.verify(await rotating.token({ sub: 's1' }))).resolves.toBeDefined();
      expect(rotating.fetches).toBe(before + 1);
      const { privateKey } = await generateKeyPair('ES256');
      const unknownKid = (n: number) =>
        new SignJWT({ sub: 's1' })
          .setProtectedHeader({ alg: 'ES256', kid: `nope-${n}` })
          .setIssuer(rotating.issuer)
          .setAudience(TEST_AUDIENCE)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
      for (const n of [1, 2, 3])
        expect(await reason(verify.verify(await unknownKid(n)))).toBe('AUTH_TOKEN_INVALID');
      expect(rotating.fetches).toBe(before + 1);
    } finally {
      await rotating.close();
    }
  });

  it('keeps serving during an IdP outage, then answers 503, never 401', async () => {
    const shaky = await createTestIssuer();
    try {
      const set = keySetFor(shaky, { maxStaleMs: 60_000 });
      const verify = verifierFor([{ issuer: shaky, keySet: set }]);
      await set.refresh();
      shaky.setDown(true);
      await set.refresh();
      expect(set.state).toBe('stale');
      await expect(verify.verify(await shaky.token({ sub: 's1' }))).resolves.toBeDefined();
      const cold = keySetFor(shaky);
      const coldVerifier = verifierFor([{ issuer: shaky, keySet: cold }]);
      expect(cold.state).toBe('unavailable');
      expect(await reason(coldVerifier.verify(await shaky.token({ sub: 's1' })))).toBe(
        'IDENTITY_PROVIDER_UNAVAILABLE',
      );
    } finally {
      await shaky.close();
    }
  });

  it('never fetches on the request path while the keys are unavailable', async () => {
    let fetches = 0;
    const set = new IdpKeySet('http://unused', options, async () => {
      fetches += 1;
      throw new Error('connection refused');
    });
    stops.push(set);
    expect(await set.refresh()).toBe(false);
    const verify = verifierFor([{ issuer: idp, keySet: set }]);
    const token = await idp.token({ sub: 's1' });
    for (let n = 0; n < 50; n += 1) {
      expect(await reason(verify.verify(token))).toBe('IDENTITY_PROVIDER_UNAVAILABLE');
    }
    expect(fetches).toBe(1);
  });

  it('answers 503, not 401, for a new kid it could not fetch', async () => {
    const shaky = await createTestIssuer();
    try {
      const set = keySetFor(shaky, { unknownKidCooldownMs: 60_000 });
      const verify = verifierFor([{ issuer: shaky, keySet: set }]);
      await set.refresh();
      const known = await shaky.token({ sub: 's1' });
      await shaky.rotate();
      shaky.setDown(true);
      const rotated = await shaky.token({ sub: 's1' });
      // The first one spends the cooldown on a failed fetch, the second one is inside it.
      expect(await reason(verify.verify(rotated))).toBe('IDENTITY_PROVIDER_UNAVAILABLE');
      expect(await reason(verify.verify(rotated))).toBe('IDENTITY_PROVIDER_UNAVAILABLE');
      await expect(verify.verify(known)).resolves.toBeDefined();
    } finally {
      await shaky.close();
    }
  });

  it('stops trusting keys it could not refresh for longer than the max-stale window', async () => {
    const shaky = await createTestIssuer();
    try {
      const set = keySetFor(shaky, { maxStaleMs: 60_000 });
      const verify = verifierFor([{ issuer: shaky, keySet: set }]);
      await set.refresh();
      const token = await shaky.token({ sub: 's1' });
      shaky.setDown(true);
      await set.refresh();
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 59_000 });
      expect(set.state).toBe('stale');
      await expect(verify.verify(token)).resolves.toBeDefined();
      vi.setSystemTime(Date.now() + 2_000);
      expect(set.state).toBe('unavailable');
      expect(await reason(verify.verify(token))).toBe('IDENTITY_PROVIDER_UNAVAILABLE');
    } finally {
      vi.useRealTimers();
      await shaky.close();
    }
  });

  it('retries within seconds after a periodic refresh fails, keeping the old keys', async () => {
    const jwk = { ...(await exportJWK((await generateKeyPair('ES256')).publicKey)), kid: 'k1' };
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter: the refresh is exactly refreshMs
    try {
      let attempts = 0;
      const set = new IdpKeySet('http://unused', options, async () => {
        attempts += 1;
        if (attempts === 2) throw new Error('connection refused');
        return { keys: [jwk] };
      });
      set.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(set.state).toBe('ok');
      await vi.advanceTimersByTimeAsync(options.refreshMs);
      expect(attempts).toBe(2);
      expect(set.state).toBe('stale');
      await vi.advanceTimersByTimeAsync(500);
      expect(attempts).toBe(3);
      expect(set.state).toBe('ok');
      set.stop();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('is on its short backoff when the last good keys expire', async () => {
    const jwk = { ...(await exportJWK((await generateKeyPair('ES256')).publicKey)), kid: 'k1' };
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      let down = false;
      const set = new IdpKeySet(
        'http://unused',
        { ...options, refreshMs: 280_000, maxStaleMs: 581_600 },
        async () => {
          if (down) throw new Error('connection refused');
          return { keys: [jwk] };
        },
      );
      set.start();
      await vi.advanceTimersByTimeAsync(0);
      down = true;
      // Retries back off to 30 s while the keys still work; they expire at 581.6 s.
      await vi.advanceTimersByTimeAsync(581_601);
      expect(set.state).toBe('unavailable');
      down = false;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(set.state).toBe('ok');
      set.stop();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('retries a failed first fetch within seconds (cold start)', async () => {
    const jwk = { ...(await exportJWK((await generateKeyPair('ES256')).publicKey)), kid: 'k1' };
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const set = new IdpKeySet('http://unused', options, async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('connection refused');
        return { keys: [jwk] };
      });
      set.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(set.state).toBe('unavailable');
      await vi.advanceTimersByTimeAsync(1_600); // 500 ms, then 1 s
      expect(attempts).toBe(3);
      expect(set.state).toBe('ok');
      set.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a JWKS with duplicate kids as a whole', async () => {
    const set = new IdpKeySet('http://unused', options, async () => ({
      keys: [
        { kty: 'EC', crv: 'P-256', x: 'a', y: 'b', kid: 'same' },
        { kty: 'EC', crv: 'P-256', x: 'c', y: 'd', kid: 'same' },
      ],
    }));
    expect(await set.refresh()).toBe(false);
    expect(set.state).toBe('unavailable');
  });

  it('parses only Bearer authorization headers', () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
    for (const header of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer a b', 'Token abc']) {
      expect(() => bearerToken(header)).toThrow('the bearer token is invalid');
    }
  });

  describe('email policies', () => {
    const token = (
      claims: Record<string, unknown>,
      config: Partial<IssuerConfig> = {},
    ): VerifiedAccessToken => ({
      token: 't',
      issuer: issuerConfig(idp, config),
      subject: 's1',
      claims: { sub: 's1', ...claims },
    });
    const userinfo = (claims: Record<string, unknown>) => async () => claims;

    it('verified-claim: takes a verified email from the token', async () => {
      await expect(acceptedEmail(token({ email: 'a@b.io', email_verified: true }))).resolves.toBe(
        'a@b.io',
      );
      await expect(acceptedEmail(token({ email: 'a@b.io', email_verified: 'true' }))).resolves.toBe(
        'a@b.io',
      );
    });

    it('verified-claim: falls back to userinfo, else refuses', async () => {
      const withUserinfo = token({ email: 'a@b.io' }, { userinfoUri: 'http://127.0.0.1/userinfo' });
      await expect(
        acceptedEmail(withUserinfo, userinfo({ sub: 's1', email: 'a@b.io', email_verified: true })),
      ).resolves.toBe('a@b.io');
      expect(await reason(acceptedEmail(token({ email: 'a@b.io' })))).toBe('EMAIL_NOT_VERIFIED');
      expect(await reason(acceptedEmail(token({ email: 'a@b.io', email_verified: false })))).toBe(
        'EMAIL_NOT_VERIFIED',
      );
    });

    it('userinfo: always asks the provider, about the same subject', async () => {
      const config = { emailPolicy: 'userinfo', userinfoUri: idp.userinfoUri } as const;
      idp.setUserinfo('s1', { sub: 's1', email: 'u@b.io', email_verified: true });
      const real = await idp.token({ sub: 's1' });
      const verified = await verifierFor([{ issuer: idp, keySet, config }]).verify(real);
      await expect(acceptedEmail(verified)).resolves.toBe('u@b.io');
      idp.setUserinfo('s1', { sub: 'someone-else', email: 'u@b.io', email_verified: true });
      expect(await reason(acceptedEmail(verified))).toBe('EMAIL_NOT_VERIFIED');
    });

    it('trusted-claim takes the claim as-is; none never stores an email', async () => {
      await expect(
        acceptedEmail(token({ email: 't@b.io' }, { emailPolicy: 'trusted-claim' })),
      ).resolves.toBe('t@b.io');
      await expect(
        acceptedEmail(token({ email: 't@b.io', email_verified: true }, { emailPolicy: 'none' })),
      ).resolves.toBeNull();
    });
  });
});
