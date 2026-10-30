# ADR-0003: API and error conventions

- Status: Accepted
- Date: 2026-10-30

## Context

Clients need to branch on failures reliably, and every module must fail the same way.

## Decision

**Errors**: business failures are `DomainError` subclasses from `@gam/kernel` with a
stable UPPER_SNAKE `reason`. The platform's `ProblemDetailsFilter` (the app's only
exception filter) maps the kind to an HTTP status; unknown errors become 500 `INTERNAL`
without internals. Domain error messages and metadata are client-facing by contract.

| Kind                       | HTTP                  |
| -------------------------- | --------------------- |
| ValidationError            | 400                   |
| NotFoundError              | 404                   |
| ConflictError              | 409                   |
| PreconditionFailedError    | 400                   |
| ConcurrencyError           | 409                   |
| PermissionDeniedError      | 403                   |
| UnauthenticatedError       | 401                   |
| RateLimitedError           | 429                   |
| DependencyUnavailableError | 503                   |
| (the request's deadline)   | 504 `REQUEST_TIMEOUT` |
| (unexpected)               | 500 `INTERNAL`        |

**Database errors** no repository translated are translated by the filter itself:
deadlocks and serialization failures become 409 `TRANSACTION_CONFLICT`, statement
timeouts 503 `DATABASE_TIMEOUT`, from any query (a read, `SELECT ... FOR UPDATE`, the
commit). `DB_STATEMENT_TIMEOUT_MS` (1.5 s) keeps a slow statement or lock wait from
holding a connection until the request's own deadline. Invariants the database enforces
(unique keys, the bookings exclusion constraint) are translated by the repository into
their domain reason (`translateDbError`).

**Authentication and authorization (ADR-0004)**: 401 with `AUTH_TOKEN_MISSING`,
`AUTH_TOKEN_INVALID` or `AUTH_TOKEN_EXPIRED` and a `WWW-Authenticate: Bearer` header
(RFC 6750), 403 with `USER_NOT_REGISTERED`, `EMAIL_NOT_VERIFIED`, `ADMIN_ROLE_REQUIRED` or a
resource reason such as `HOUSE_PERMISSION_DENIED`, and 503 with
`IDENTITY_PROVIDER_UNAVAILABLE`. A resource the caller may not see is a 404 with the same
reason as a missing one.

**Deadlines**: a request that outlives `REQUEST_TIMEOUT_MS` (30 s, body upload included)
gets 504 `REQUEST_TIMEOUT`: its work may already have committed, so the outcome is unknown
and a client must not blindly retry a write. A request whose deadline passed before its
controller started never starts it, and a stalled upload is cut off (RST_STREAM NO_ERROR
on HTTP/2, `Connection: close` on HTTP/1.1).

**REST**: versioned paths (`/v1`), plural resources, camelCase JSON, ISO-8601 times,
calendar dates as `YYYY-MM-DD`, money as `{ currencyCode, amountMinor }`,
`{ items, nextPageToken }` lists with keyset pagination (`pageSize`, `pageToken`; tokens
bound to the filters and, where lists are per caller, to the caller), 201 + `Location`
on create, 204 on delete, custom actions as `POST /v1/<resources>/{id}/<verb>`, `me` for
the signed-in user where a user id goes. Every error is RFC 9457
`application/problem+json` with `code` (the reason), `metadata`, `errors[]` (invalid
fields) and `requestId`; `detail` is omitted for 5xx. Request bodies, queries and params
are validated by Zod schemas, which also generate the OpenAPI document (`/openapi.json`,
`/docs`).

## Consequences

Clients branch on `code`, never on messages. Changing an existing reason is a breaking
change. A module's public API (ADR-0002) throws the same DomainErrors in process; its
callers translate what they expect (`HousesApi.findHouse` answers null for a missing
house) and let the rest surface.
