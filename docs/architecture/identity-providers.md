# Identity providers

The API trusts OIDC access tokens of the providers in `AUTH_ISSUERS` (ADR-0004). The
provider is a deployment decision; nothing in the modules depends on it. Locally the
stack runs `tools/dev-idp/main.ts`, a loopback-only provider that signs any subject it is
asked for (it refuses `NODE_ENV=production`).

## What the API needs from a provider

| Need                         | Why                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------ |
| JWT access tokens            | opaque tokens would need an introspection call per request                     |
| `aud` = the API's identifier | the API accepts only its own audience, so tokens for other clients do not work |
| asymmetric signatures + JWKS | RS256/ES256 (or PS*/ES384/EdDSA); `none` and HS* cannot be configured          |
| a stable `sub`               | the login's id; users are mapped through `(issuer, subject)`                   |
| a verified email, or none    | chosen per issuer with `emailPolicy`                                           |

`AUTH_ISSUERS` entry:

```json
{
  "issuer": "https://login.example.com/",
  "audience": "https://api.example.com",
  "jwksUri": "https://login.example.com/.well-known/jwks.json",
  "algorithms": ["RS256"],
  "userinfoUri": "https://login.example.com/userinfo",
  "requiredTyp": "at+jwt",
  "emailPolicy": "verified-claim"
}
```

`issuer` must equal the tokens' `iss` exactly (trailing slash included). URIs must be
https except loopback outside production. `requiredTyp` is optional because providers
differ (RFC 9068 says `at+jwt`).

## What a browser (BFF) client needs

A server-side web client such as `global-architecture-web` signs users in with its own
client registration at the same provider, and sends the access tokens it receives here.

| Need                                        | Why                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| a confidential client with code flow + PKCE | tokens stay on the web server; the browser only holds a session cookie     |
| access tokens with the API's `aud`          | the API refuses tokens minted for other audiences (ID tokens included)     |
| refresh tokens (`offline_access`)           | sessions outlive short access tokens; prefer rotation with reuse detection |
| `end_session_endpoint`                      | signing out of the web also ends the provider's session                    |
| `iss` in authorization responses (RFC 9207) | mix-up defense in the client                                               |

Locally the dev IdP offers all of it for the clients in `modules.json`
(`devIdp.clients`): `GET /authorize` shows a sign-in form that takes any subject and an
access-token lifetime (short ones exercise refresh), and a rotated refresh token
presented again revokes the login, so refresh races in a client fail locally.

## Email policy

| `emailPolicy`              | The new user's email                                                    | Use when                                                     |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `verified-claim` (default) | `email` + `email_verified` from the token; otherwise from `userinfoUri` | the provider verifies emails (Keycloak, Auth0, Cognito, ...) |
| `userinfo`                 | always from `userinfoUri` (needs `openid email` scopes)                 | access tokens carry no email claims                          |
| `trusted-claim`            | the `email` claim as is, unverified                                     | a single-tenant workforce IdP whose emails you control       |
| `none`                     | no email (users may have none)                                          | the provider shares no email                                 |

Registration fails with 403 `EMAIL_NOT_VERIFIED` when the policy needs a verified email
and there is none. The email is set once at registration; it cannot be changed through
the API.

## Notes per provider

These are starting points; verify them against the provider's current documentation
when you adopt one.
- **Keycloak**: access tokens default to `aud: account`; add an audience mapper to the
  client so they carry the API's audience. `emailPolicy: verified-claim`.
- **Auth0**: create an API with the audience identifier and request tokens for it;
  access tokens carry no email by default, so use `emailPolicy: userinfo` with the
  `openid email` scopes.
- **Microsoft Entra ID**: use the application ID URI as the audience; there is no
  `email_verified` claim and the userinfo endpoint needs a Graph token, so use
  `trusted-claim` (with the optional `email` claim) or `none`.
- **Amazon Cognito**: access tokens carry `client_id` rather than `aud`, and the API
  requires `aud`. Check whether your setup can add an `aud` claim before choosing it.

## Changing provider

1. Import the users into the new provider, so their new subjects are known.
2. Map existing users to their new logins **before** the API trusts the issuer:
   insert `users.identities (issuer, subject, user_id, created_at)` rows in
   the app database, matched by a reliable attribute exported from both
   providers. Never link logins by email automatically. In the other order, a user
   who signs in early gets "not registered", registers a second account (or hits
   `USER_EMAIL_TAKEN`), and the mapping insert then conflicts with that login.
3. Add the new issuer to `AUTH_ISSUERS` (up to five issuers are trusted at once) and
   roll out the API.
4. Remove the old issuer when its tokens have expired.
