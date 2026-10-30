import type { DomainErrorKind } from '@gam/kernel';

/** Domain error kind -> HTTP status (the mapping of google/rpc/code.proto). */
export const KIND_TO_HTTP_STATUS: Readonly<Record<DomainErrorKind, number>> = Object.freeze({
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  FAILED_PRECONDITION: 400,
  ABORTED: 409,
  PERMISSION_DENIED: 403,
  UNAUTHENTICATED: 401,
  RESOURCE_EXHAUSTED: 429,
  UNAVAILABLE: 503,
});
