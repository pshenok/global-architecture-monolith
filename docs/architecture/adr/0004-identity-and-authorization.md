# ADR-0004: Identity and authorization

- Status: Accepted
- Date: 2026-10-30
- Derived from: ADR-0004 of `global-architecture` (2026-10-23), without its workload
  identity: there are no calls between processes to authenticate.

## Context

Authentication and authorization must be secure by default, cheap to get right in a new
module, and loud when someone gets it wrong, with no identity infrastructure of our own
and no identity provider chosen yet. Threat model: anyone on the internet can call the
API, tokens can leak (logs, debugging), and code is written by many people and AI agents.
Inside the process modules trust each other; what keeps them honest is the boundary
rules of ADR-0002, not tokens.

## Decision

### 1. Authentication happens once, at the edge

The API verifies OIDC **access tokens** of any configured provider
(`AUTH_ISSUERS`, one to five issuers, so an IdP migration can trust two at once):
asymmetric algorithms only (`none` and HS* cannot be configured), exact issuer and
audience (the API's own audience, never a client id), required `kid`, `exp`, `iat` and
`sub`, `nbf` honoured, `AUTH_CLOCK_TOLERANCE_S` (30 s) of skew, and ID tokens
(`nonce`, `at_hash`, `c_hash`) refused.

Provider keys are fetched by one background loop per provider: every
`AUTH_JWKS_REFRESH_S` (5 min), and after a failure again within seconds (backoff up to
5 s without usable keys, 30 s with). A request never starts a fetch of its own while
the keys are unusable; it only waits for one already running. The last good keys keep
working for `AUTH_JWKS_MAX_STALE_S` (30 min, at least twice the refresh interval) while
refreshes fail; after that, and while no keys were ever loaded, requests get
**503 IDENTITY_PROVIDER_UNAVAILABLE, never 401**, so clients do not throw valid tokens
away. A token with an unknown `kid` triggers at most one extra fetch per
`AUTH_JWKS_UNKNOWN_KID_COOLDOWN_S`, measured from the previous unknown-kid fetch, so key
rotation works within seconds and forged kids cannot hammer the provider. It is a 401
only when the last fetch succeeded without that kid; while fetches fail it is a 503
(the key may be new). `/readyz` reports the provider's state but does not fail on it:
public routes and cached keys keep working during an IdP outage.

Every route declares its policy (section 3). A token sent to a public route is still
verified (a bad one is a 401, never a silent downgrade, unless the provider is
unavailable, which does not fail a public route), but it is not resolved: the handler
sees an anonymous actor. Health probes ignore the Authorization header altogether
(`@Access.public(reason, { ignoreToken: true })`). 401 responses carry
`WWW-Authenticate: Bearer` (RFC 6750).

### 2. Platform users are separate from identity-provider logins

`users.id` is an application-generated UUIDv7; every other module references it
(`houses.owner_id`, `bookings.guest_id`, `bookings.host_id`). The users module owns
`users.identities (issuer, subject) -> user_id`. One user can have several logins, and
two issuers with the same `sub` are different logins.
- **Registration** (`POST /v1/users`) is explicit. The issuer, subject
  and email come from the verified token, never from the request body. The email
  follows the issuer's `emailPolicy`: `verified-claim` (default: `email` +
  `email_verified`, else userinfo), `userinfo`, `trusted-claim` (only for a provider
  whose emails the operator controls) or `none` (users without email are allowed).
  Concurrent registrations of one login yield one user; the losers get
  `USER_ALREADY_REGISTERED`.
- **Resolution**: the AuthGuard asks the platform's `IdentityResolver` port, which the
  users module implements (`UsersIdentityResolver`) and the app binds in
  `PlatformModule.forRoot({ identities })`, on every request that needs a user: an
  indexed lookup in the same database, no cache. A role change or a deletion applies to
  the very next request, and a login of a deleted user is unregistered at once.
- **Roles** are platform data in `users.roles` (today: `admin`), granted and revoked
  with `pnpm users:grant-role|users:revoke-role <userId> admin --by <name>` (the app's
  role CLI, `@gam/users/ops`). Each change prints one line naming who made it (`--by`,
  else the OS user the CLI runs as, which in a container is the image's user); that line
  is the only record, so runbooks keep it. An IdP role never becomes a platform role, so
  an IdP administrator is not a platform administrator.
- Logins are **never linked by email** (that would let an IdP with weak email
  verification take accounts over). Moving to another IdP means inserting
  `users.identities` rows for the new subjects first, then adding the new issuer, then
  removing the old one (in the other order, early logins would register as new users).

### 3. Every route declares its access policy

`PlatformModule` installs the `AuthGuard` (after the rate limiter) without an off switch.
Each route method carries exactly one `@Access` decorator, and an app with an undeclared
route refuses to start (so the first test fails, not production):

| Policy                             | Who may call                                       |
| ---------------------------------- | -------------------------------------------------- |
| `@Access.user()`                   | a registered user                                  |
| `@Access.admin()`                  | a registered user with the admin role (else 403)   |
| `@Access.identity()`               | a verified login, registered or not (registration) |
| `@Access.public(reason, options?)` | anyone; the handler sees an anonymous actor        |

Policies are method-only (a policy on a controller class fails at boot). `AccessRoutes`
records them once at boot, per controller and handler (bound copies included), and the
guard enforces that record, not live metadata; a handler that was not a route at boot is
refused.

### 4. Authorization lives in the module that owns the data

Controllers take the actor from the request context (`currentUser()`) and pass it as
the first argument of the use case; use cases never read context themselves. The
rules live in the domain (`House.assertManageableBy`, `Booking.isVisibleTo`,
`bookingScopeFor`, `User.isVisibleTo`), so a second transport cannot bypass them.
Verified actors are branded types: production code cannot build one from request
fields. Rules:
- If the caller may not know that a resource exists, the answer is 404, with the same
  reason and message as for a missing one (bookings, users, the template's items). If the
  resource is visible (the public house catalogue) but the action is not allowed, the
  answer is 403.
- Lists never fail because of what the caller cannot see: repositories take a typed
  scope (`BookingScope`) and return only what it covers. Only asking for a scope the
  caller may not have is refused (a non-admin listing bookings `as=any` gets 403). Page
  tokens are bound to the caller and the scope.
- Facts a check needs from another module are snapshotted when they are immutable:
  bookings store the house owner as `host_id` (houses never change owner; a future
  transfer must publish an event that updates the snapshots, ADR-0005).
- A module's public API that answers about users takes the acting user and decides as
  the use case would (`UsersApi.stillExists(actor)`), so one module cannot ask another
  about someone the request does not act for.

| Operation                                     | Rule                                                  |
| --------------------------------------------- | ----------------------------------------------------- |
| register                                      | the login itself (`@Access.identity()`)               |
| get / rename / delete a user (`/v1/users/me`) | self or admin, else 404; ListUsers admin only         |
| list a house                                  | any user; the caller becomes the owner                |
| read houses                                   | public                                                |
| change / delete a house                       | owner or admin, else 403 HOUSE_PERMISSION_DENIED      |
| book                                          | any user; the caller is the guest, the owner the host |
| read / cancel a booking                       | guest, host or admin, else 404                        |
| list bookings (`?as=guest\|host\|any`)        | own as guest or host; `any` for admins (else 403)     |

### 5. Guardrails

- `pnpm lint` runs `tools/check-access.ts`, which reads the code with the TypeScript 7
  checker (`typescript/unstable/sync`), so names resolve through imports, renames,
  namespaces and type aliases. Every route that does not need a registered user (public
  and identity) is listed with its reason in `security/public-endpoints.json`. `@Access`
  may appear only as a decorator written on a route method with inline literal
  arguments; any other use of it or of its metadata (`SetMetadata`, `Reflect`, the key
  strings) fails. Outside the platform kit nothing may produce a value whose type carries
  the actor brand: no type assertion or type predicate to a type that is or holds an
  actor, to `never` or to a type built from a type parameter; no actor object literal
  (spread, computed key); no call or property read that returns an actor its declaration
  does not promise (a generic helper, `structuredClone`, `Object.assign`, a generic
  `value!: T`); no definitely-assigned actor field; no actor taken by constructor
  injection, from the request or as a typed callback parameter; no overload, ambient
  declaration or module augmentation of one. Biome and oxlint refuse explicit and
  implicit `any`, and check-access refuses `@ts-ignore`-style comments, suppressions of
  the any-rules and non-`.ts` files. No production code reaches the test helpers, loads a
  module by a computed path or `createRequire`, or (outside the platform kit) touches the
  raw server, Nest middleware or Nest's registries. The request context keeps the actor
  under the kit's private symbols and gives back only actors the kit minted; outside the
  kit no code imports `nestjs-cls` (where the context lives) or suppresses Biome's import
  rules to reach it. TypeScript is not sound, so these
  rules list the ways around the brand that reviews found; each is a probe
  (`modules/houses/test/access-probes`, `apps/api/test/access-probes`) that check-access
  checks on every run, so a rule that stops working fails lint.
- What runs is what the tests check: `createTestApp` (with `checkPublicEndpoints`, as the
  app's own tests run it) fails when the open routes recorded at boot differ from the
  list. Once Fastify is ready it also fails on any route, hook, plugin, handler or
  middleware added outside the controllers by code other than packages and the platform's
  `http/bootstrap.ts` and `http/openapi.ts`; each registration is attributed to the code
  that called it, and an unknown caller is refused.
- What neither sees is code that defeats the type checker at run time (`eval` and the
  like) or edits the guardrails themselves; that is what CODEOWNERS review is for.
  `.github/CODEOWNERS` covers `security/`, the whole platform kit and its tests, the
  kernel's actor, testing and index files, the app's composition, main and boot tests
  (`app.spec.ts`), the guardrail tools and their probes, `modules.json`, and everything
  that decides whether and how the checks run.
- The module template starts every new module with five access tests (no user, another
  user, admin, a stranger's empty list, a login without a user).

### Local development

`pnpm stack:up` runs a loopback-only OIDC provider (`tools/dev-idp/main.ts`, refuses
production). `pnpm dev:token <sub> --email ...` prints a token. Browser clients (the
BFF in `global-architecture-web`) sign in through its authorization code flow with
PKCE: a sign-in form that takes any subject, ID tokens, refresh tokens that rotate on
every use (a reused one revokes the login) and RP-initiated logout. Clients are
registered in `modules.json` (`devIdp.clients`) with a committed, labelled
non-secret. One issuer for both paths means `pnpm dev:token alice` and a web login as
alice are the same platform user. See `docs/architecture/identity-providers.md` for
adopting a real provider and what a BFF client needs from it.

## Rejected alternatives

1. **Workload identity between modules** (signed caller and principal tokens per hop, as
   in `global-architecture`): there is no hop. Modules run in one process and trust each
   other; their boundaries are enforced statically and at run time (ADR-0002).
2. **Forwarding the IdP token into modules**: every module would depend on the IdP and
   its claim shapes. Modules see a verified actor only.
3. **An identity cache**: the lookup is one indexed query in the same database; a cache
   would make role changes and deletions take effect late, for no measured gain.
4. **`users.id` = IdP subject or a UUIDv5 of it**: ties the platform to one IdP and
   breaks UUIDv7 ordering.
5. **Roles from IdP claims**: an IdP admin (or a user-writable attribute mapped to the
   claim) would become a platform admin, and claim shapes differ per IdP.
6. **Auto-registration on first login or linking by email**: account squatting and
   takeover.
7. **jose `createRemoteJWKSet` as is**: on an IdP outage it fails every request on the
   request path.
8. **Authorization in the guard** beyond the route policy: the guard has no data; rules
   live in the module that owns it.
9. **Reading the actor from context inside use cases**: invisible to tests, fails open.
10. **OPA/Cedar/OpenFGA, passport, a Keycloak container**: disproportionate for
    ownership rules; jose covers the cryptography.
11. **An `AUTH_DISABLED` switch**: agents would use it.

## Consequences

- Every request that needs a user costs one token verification and one indexed query.
  The API is the only place that talks to the IdP.
- A deleted user's houses and bookings are cleaned up through events, within seconds
  (ADR-0005).
- If a module moves out to a service, it gets the workload identity of
  `global-architecture` at that boundary; the route policies, the actor brand and the
  guardrails stay as they are.
