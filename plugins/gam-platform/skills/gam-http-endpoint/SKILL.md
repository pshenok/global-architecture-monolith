---

name: gam-http-endpoint
description: Expose a module's functionality through the public HTTPS REST API of global-architecture-monolith - controllers inside the module (src/transport/http), exactly one @Access per route method (user, admin, identity, public(reason)) and security/public-endpoints.json for routes open without a registered user, Zod body/query/param schemas with .meta({ id }) that both validate and generate the OpenAPI document, currentUser() and `me` instead of ids from the request, keysetPaging and the { items, nextPageToken } envelope, view mappers, 201 + Location, 204 deletes, RFC 9457 problem+json errors including 401/403/503/504, and the cross-cutting behaviour already on. Use it whenever a client, frontend or partner needs an endpoint, when a use case should become reachable over HTTP, when a route should work without signing in, or when OpenAPI docs, error responses or REST field names need to change.
---

# HTTP endpoints

Unlike global-architecture, there is no gateway: each module serves its own REST routes
from `src/transport/http/`, and `apps/api` serves every mounted module behind one Fastify
server (HTTPS, HTTP/2 + HTTP/1.1) and one OpenAPI document. A controller holds no business
logic: it validates, calls one use case with the acting user, and maps the result to a
view. Authentication is the platform's `AuthGuard`; authorization (owner, admin,
visibility) stays in the module's domain.

## Anatomy (users is the simplest, bookings shows a custom action)

```
modules/<m>/src/transport/http/<plural>.schemas.ts      Zod: bodies, queries, params, views + toXView mapper
modules/<m>/src/transport/http/<plural>.controller.ts   routes, one @Access each
modules/<m>/src/<m>.module.ts                           controllers: [XController]
security/public-endpoints.json                          routes open without a registered user, with reasons
modules/<m>/test/<plural>.http.spec.ts                  createTestApp: the real HTTP stack on a test database
```

## Who may call a route (ADR-0004)

Every route method carries exactly one `@Access` decorator, written directly above the
method with inline literal arguments. The app refuses to start when a route has none
(`routes without an @Access policy: ...`); a second one on the same method throws when the
class loads; policies are method-only. The `AuthGuard` enforces the policies recorded at
boot, not live metadata.

| Route                                  | Decorator                                      | The handler sees                                      |
| -------------------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| a registered user (the default choice) | `@Access.user()`                               | `currentUser()`: a `UserActor`                        |
| a user with the admin role             | `@Access.admin()`                              | `currentUser()`; others get 403 `ADMIN_ROLE_REQUIRED` |
| a verified login without a user        | `@Access.identity()` (registration only)       | `currentIdentity()`: issuer, subject, accepted email  |
| anyone                                 | `@Access.public('world-readable catalogue')`   | an anonymous actor                                    |
| probes that must never read a token    | `@Access.public('...', { ignoreToken: true })` | an anonymous actor                                    |
- Every `public` and `identity` route is listed in `security/public-endpoints.json` with
  the same reason (identity routes always say `login without a user`):
  `{ "where": "modules/houses/src/transport/http/houses.controller.ts#HousesController.list", "access": "public", "reason": "world-readable catalogue" }`.
  The list has code owners. `check-access` (in `pnpm lint`) compares it with the source,
  and the app's test (`createTestApp` with `checkPublicEndpoints`) with the open routes the
  app recorded at boot. Any other use of `Access`, `ACCESS_POLICY`, `PUBLIC_EXTENSION`,
  `SetMetadata` or `Reflect` metadata fails `check-access` (a computed reason, a wrapper,
  a renamed import, a decorator kept in a constant).
- A token sent to a public route is still verified (a bad one is a 401, never a silent
  downgrade; during an IdP outage it is skipped), but never resolved: a public route sees
  an anonymous actor, so it can only call use cases that need no user.
- Routes are controller methods only. Raw Fastify routes, hooks, plugins and Nest
  middleware skip the guard: outside the platform's `http/bootstrap.ts` and
  `http/openapi.ts`, `check-access` fails `HttpAdapterHost`, `getHttpAdapter`,
  `getInstance`, `MiddlewareConsumer`, Fastify route methods and Nest's registries, and
  `createTestApp` fails on anything such code registers.
- **Never take the acting user's id from the body, query or path.** Use cases take owner,
  guest and user from `currentUser()`. `me` means the signed-in user (`/v1/users/me`; the
  users controller maps it with `id === 'me' ? currentUser().userId : id`, and its
  `UserIdParam` accepts `'me'` or a UUID). Ids that address other resources (`houseId`) or
  filter a public list (`ownerId`) are fine. A Zod object strips unknown keys, so a
  smuggled `ownerId` in a body never reaches the use case; test it anyway (houses: "takes
  the owner from the signed-in user, never from the body").

## REST conventions (ADR-0003)

| Operation          | Route                                                                           | Success                                  |
| ------------------ | ------------------------------------------------------------------------------- | ---------------------------------------- |
| create             | `POST /v1/houses`                                                               | 201 + `Location: /v1/houses/{id}` + body |
| list               | `GET /v1/houses?ownerId=&city=&pageSize=&pageToken=`                            | 200 `{ items, nextPageToken \| null }`   |
| list own data      | `GET /v1/bookings?as=guest\|host\|any` (scoped in the domain)                   | 200 `{ items, nextPageToken \| null }`   |
| get                | `GET /v1/houses/{id}`                                                           | 200                                      |
| the signed-in user | `GET`/`PATCH`/`DELETE /v1/users/me`                                             | 200 / 200 / 204                          |
| partial update     | `PATCH /v1/houses/{id}` (only sent fields change; nested objects replace whole) | 200                                      |
| delete             | `DELETE /v1/houses/{id}`                                                        | 204                                      |
| custom action      | `POST /v1/bookings/{id}/cancel`                                                 | 200 + resource                           |

Nest answers `@Post()` with 201 and `@Delete()` with 200, so a delete needs
`@HttpCode(204)` and a custom action needs `@HttpCode(200)`. Paths are versioned (`/v1`),
plural nouns, camelCase JSON, ISO-8601 timestamps, `YYYY-MM-DD` dates, money as
`{ currencyCode, amountMinor }`, enums as plain strings (`"CONFIRMED"`).

## Schemas: one Zod schema = validation + documentation

```ts
/** The owner is the signed-in user; it is never taken from the body. */
export const CreateHouseBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  ...
}).meta({ id: 'CreateHouseBody' });          // components/schemas/CreateHouseBody

export const HouseView = z.object({ id: z.uuid(), ownerId: z.uuid(), ..., nightlyPrice: MoneyView,
  createdAt: z.iso.datetime() }).meta({ id: 'House' });
export const HousePage = pageOf(HouseView, 'HousePage');

export function toHouseView(house: House): z.output<typeof HouseView> { ... } // dates via toISOString()
```

- Mirror the domain's limits so clients get precise errors and the OpenAPI document tells
  the truth; the domain validates again, on purpose.
- Schema ids are global in the one document: prefix them with your resource.
- Shared pieces from `@gam/platform`: `IdParam` (a UUID), `PageQuery` (`pageSize` 0..1000
  coerced, 0 = 20, capped at 100; `pageToken`), `MoneyView`, `pageOf(item, id)`,
  `ProblemDetails`.
- Query strings are strings: use `z.coerce.number()`; extend `PageQuery` for list filters
  (`const ListHousesQuery = PageQuery.extend(HouseQuery.shape)`).

## Controller

```ts
@ApiTags('houses')
@ApiResponse({ status: 400, description: 'Invalid input', standardSchema: ProblemDetails })
@Controller('v1/houses')
export class HousesController {
  constructor(private readonly houses: HouseService) {}

  @Post()
  @Access.user()
  @ApiOperation({ summary: 'List a house; the signed-in user becomes its owner' })
  @ApiResponse({ status: 201, standardSchema: HouseView })
  async create(
    @Body({ schema: CreateHouseBody }) body: z.output<typeof CreateHouseBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const view = toHouseView(await this.houses.create(currentUser(), body));
    void reply.header('location', `/v1/houses/${view.id}`);
    return view;
  }

  @Get()
  @Access.public('world-readable catalogue')
  async list(@Query({ schema: ListHousesQuery }) query: z.output<typeof ListHousesQuery>) {
    const filter = { ownerId: query.ownerId, city: query.city };
    const paging = keysetPaging(query, filter);
    const page = await this.houses.list(filter, paging.request);
    return { items: page.items.map(toHouseView), nextPageToken: paging.next(page) };
  }
}
```

- `@Body/@Query/@Param({ schema })` are validated by the platform's global
  `StandardSchemaValidationPipe`; failures become 400 `VALIDATION_FAILED` with `errors[]`
  (`field` paths like `nightlyPrice.currencyCode`).
- **Paging**: `keysetPaging(query, filter)` decodes the token, checks it was issued for the
  same filter (else 400 `INVALID_PAGE_TOKEN`) and gives `paging.request` for the repository
  and `paging.next(page)` for the envelope. For private lists bind the caller and the scope
  too: `keysetPaging(query, { ...filter, party: query.as, userId: actor.userId })`.
- Under `exactOptionalPropertyTypes`, declare the use case's change type with
  `?: T | undefined` so the parsed body passes as is.
- Do not catch errors in controllers; the `ProblemDetailsFilter` maps every error.
- OpenAPI security is automatic (`applySecurity`): the document requires the bearer scheme
  globally, public routes get `security: []`, every other operation gets 401 and 403
  responses. Declare a 403 yourself only to document a route-specific reason (registration
  documents `EMAIL_NOT_VERIFIED`, houses `Not your house`).

## Errors clients see

```json
{
  "type": "about:blank",
  "title": "Conflict",
  "status": 409,
  "detail": "the house is already booked for some of these dates",
  "instance": "/v1/bookings",
  "code": "BOOKING_DATES_UNAVAILABLE",
  "metadata": { "houseId": "..." },
  "requestId": "..."
}
```

`code` is the stable field clients branch on; `detail` is omitted for 5xx. Domain kinds
map by `KIND_TO_HTTP_STATUS` (`gam-domain-logic`). The platform adds:

| Status | `code`                                                             | When                                                                                                                                         |
| ------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`, `INVALID_PAGE_TOKEN`                          | a schema refused the input (`errors[]`), or a page token from other filters                                                                  |
| 401    | `AUTH_TOKEN_MISSING`, `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`   | no, bad or expired bearer token; `WWW-Authenticate: Bearer realm="gam"` (plus `error="invalid_token"` when an Authorization header was sent) |
| 403    | `USER_NOT_REGISTERED`, `EMAIL_NOT_VERIFIED`, `ADMIN_ROLE_REQUIRED` | a login without a user (register with `POST /v1/users`), registration without a verified email, an admin route                               |
| 404    | `NOT_FOUND`                                                        | no such route (Nest's own errors get the status text as `code`, e.g. 429 `TOO_MANY_REQUESTS`)                                                |
| 409    | `TRANSACTION_CONFLICT`                                             | a serialization failure or deadlock nobody translated; safe to retry                                                                         |
| 503    | `IDENTITY_PROVIDER_UNAVAILABLE`, `DATABASE_TIMEOUT`                | the IdP's keys cannot be loaded (never a 401, so clients keep valid tokens); a statement timed out                                           |
| 504    | `REQUEST_TIMEOUT`                                                  | the request outlived `REQUEST_TIMEOUT_MS` (30 s): its outcome is unknown, so clients must not blindly retry a write                          |
| 500    | `INTERNAL`                                                         | anything unexpected (logged with its stack, never shown)                                                                                     |

## Cross-cutting behaviour (already on, do not re-implement)

HTTPS with HTTP/2 + HTTP/1.1 (`TLS_ENABLED`, off only behind a TLS proxy), authentication
of every route, security headers on every response (`/docs` relaxes its own CSP), an
optional CORS allowlist (`CORS_ORIGINS`; exposes `x-request-id`, `location`,
`www-authenticate`), a rate limit per client (`RATE_LIMIT_PER_MINUTE`, 600; `@SkipThrottle()`
on the probes), a body limit (`BODY_LIMIT_BYTES`, 1 MiB), `x-request-id` in and out (an
unsafe inbound id is replaced), one access log line per request with the `authorization`
and `cookie` headers redacted, `/healthz` and `/readyz` (`gam-local-stack`), a per-request
deadline (`REQUEST_TIMEOUT_MS`, upload and handler included, HTTP/2 too: 504, the
controller never starts after it), `/openapi.json` and `/docs` (`DOCS_ENABLED`; by default
on, except when `NODE_ENV=production`).

## Tests

One spec per resource in the module's `test/`, through `createTestApp({ database, modules:
[XModule], overrides })`: `api.inject({ method, url, headers: await api.as(userId), payload
})`, `api.as(userId, ['admin'])` for an admin, `api.bearer('newcomer')` for a login without
a user, and no headers for an anonymous call. Assert status and `code` for every documented
error, that ids from the body never reach the domain, and the five access cases
(`gam-testing`). The app's test (`apps/api/test/app.spec.ts`) checks the open routes against
`security/public-endpoints.json` and that every non-public operation documents 401 and 403;
the e2e suite runs the routes on the real stack.
