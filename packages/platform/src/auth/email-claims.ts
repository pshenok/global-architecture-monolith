import { PermissionDeniedError } from '@gam/kernel';
import type { JWTPayload } from 'jose';
import { z } from 'zod';
import type { VerifiedAccessToken } from './access-token-verifier.ts';
import { identityProviderUnavailable } from './idp-key-set.ts';

const Email = z.email().max(254);

export const emailNotVerified = () =>
  new PermissionDeniedError(
    'EMAIL_NOT_VERIFIED',
    'the identity provider has not verified an email for this login',
  );

const verified = (claims: JWTPayload) =>
  claims.email_verified === true || claims.email_verified === 'true';

/**
 * The email a new user gets, per the issuer's `emailPolicy`:
 * - verified-claim: `email` + `email_verified` from the token, else from userinfo;
 * - userinfo: always from the userinfo endpoint;
 * - trusted-claim: the `email` claim as-is (only for a provider whose emails the
 *   operator controls, e.g. a single-tenant workforce IdP);
 * - none: no email.
 * Throws EMAIL_NOT_VERIFIED when the policy needs a verified email and there is none.
 */
export async function acceptedEmail(
  token: VerifiedAccessToken,
  fetchUserinfo: (token: VerifiedAccessToken) => Promise<JWTPayload> = userinfo,
): Promise<string | null> {
  const { emailPolicy } = token.issuer;
  if (emailPolicy === 'none') return null;
  if (emailPolicy === 'trusted-claim') {
    const email = Email.safeParse(token.claims.email);
    return email.success ? email.data : null;
  }
  let claims = token.claims;
  const fromToken = Email.safeParse(claims.email).success && verified(claims);
  if (emailPolicy === 'userinfo' || (!fromToken && token.issuer.userinfoUri)) {
    claims = await fetchUserinfo(token);
  }
  const email = Email.safeParse(claims.email);
  if (!email.success || !verified(claims)) throw emailNotVerified();
  return email.data;
}

/** OIDC userinfo with the user's own access token; the answer must be about the same subject. */
async function userinfo(token: VerifiedAccessToken): Promise<JWTPayload> {
  const uri = token.issuer.userinfoUri;
  if (!uri) throw emailNotVerified();
  let response: Response;
  try {
    response = await fetch(uri, {
      headers: { authorization: `Bearer ${token.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(3_000),
      redirect: 'error',
    });
  } catch {
    throw identityProviderUnavailable();
  }
  if (response.status >= 500) throw identityProviderUnavailable();
  if (!response.ok) throw emailNotVerified();
  const claims = (await response.json()) as JWTPayload;
  if (claims.sub !== token.subject) throw emailNotVerified();
  return claims;
}
