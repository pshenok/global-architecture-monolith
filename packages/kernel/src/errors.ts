/**
 * Domain errors are the only way a business rule fails.
 *
 * They are pure TypeScript and know nothing about transports. The platform kit maps
 * `kind` to an HTTP status plus RFC 9457 problem details. Never throw HTTP exceptions
 * from domain or application code; throw one of these instead.
 *
 * `message`, `reason` and `metadata` are CLIENT-FACING: the API returns them to
 * API callers (as detail, code and metadata). Write messages for API users and put
 * only identifiers the caller already knows into metadata: never secrets, internal
 * hostnames, SQL, stack traces or other users' personal data.
 */
export type DomainErrorKind =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'FAILED_PRECONDITION'
  | 'ABORTED'
  | 'PERMISSION_DENIED'
  | 'UNAUTHENTICATED'
  | 'RESOURCE_EXHAUSTED'
  | 'UNAVAILABLE';

/** One invalid input field, in the caller's field naming (camelCase). */
export interface FieldViolation {
  readonly field: string;
  readonly description: string;
}

const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,62}$/;

export abstract class DomainError extends Error {
  abstract readonly kind: DomainErrorKind;
  /** Machine-readable UPPER_SNAKE_CASE reason, e.g. `USER_EMAIL_TAKEN` (AIP-193 ErrorInfo.reason). */
  readonly reason: string;
  /** Machine-readable, client-facing context with string values only, e.g. `{ userId }`. */
  readonly metadata: Readonly<Record<string, string>>;

  constructor(
    reason: string,
    message: string,
    metadata: Record<string, string> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    if (!REASON_PATTERN.test(reason)) {
      throw new TypeError(
        `DomainError reason must be UPPER_SNAKE_CASE (<=63 chars), got "${reason}"`,
      );
    }
    this.name = new.target.name;
    this.reason = reason;
    this.metadata = Object.freeze({ ...metadata });
  }
}

/** Input is malformed or violates a rule that does not depend on system state. */
export class ValidationError extends DomainError {
  readonly kind = 'INVALID_ARGUMENT';
  readonly violations: readonly FieldViolation[];

  constructor(message: string, violations: FieldViolation[] = [], reason = 'VALIDATION_FAILED') {
    super(reason, message);
    this.violations = Object.freeze([...violations]);
  }
}

/** The addressed resource does not exist. */
export class NotFoundError extends DomainError {
  readonly kind = 'NOT_FOUND';
}

/** The resource (or a conflicting one, e.g. a unique key or an overlapping range) already exists. */
export class ConflictError extends DomainError {
  readonly kind = 'ALREADY_EXISTS';
}

/** The system is not in a state that allows the operation (e.g. cancelling a cancelled booking). */
export class PreconditionFailedError extends DomainError {
  readonly kind = 'FAILED_PRECONDITION';
}

/** A concurrency conflict (optimistic lock, serialization failure); the caller may retry. */
export class ConcurrencyError extends DomainError {
  readonly kind = 'ABORTED';
}

export class PermissionDeniedError extends DomainError {
  readonly kind = 'PERMISSION_DENIED';
}

export class UnauthenticatedError extends DomainError {
  readonly kind = 'UNAUTHENTICATED';
}

export class RateLimitedError extends DomainError {
  readonly kind = 'RESOURCE_EXHAUSTED';
}

/** A dependency (the database, an identity provider) is unreachable; the caller may retry later. */
export class DependencyUnavailableError extends DomainError {
  readonly kind = 'UNAVAILABLE';
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
