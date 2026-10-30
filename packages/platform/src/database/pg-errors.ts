import { ConcurrencyError, DependencyUnavailableError, type DomainError } from '@gam/kernel';

/** SQLSTATE codes we translate. https://www.postgresql.org/docs/current/errcodes-appendix.html */
export const PG_ERROR = Object.freeze({
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  QUERY_CANCELED: '57014',
});

export interface PgErrorInfo {
  readonly code: string;
  readonly constraint?: string;
  readonly table?: string;
}

/** Finds the pg DatabaseError behind a Drizzle error (it wraps the driver error in `cause`). */
export function pgErrorInfo(error: unknown): PgErrorInfo | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === 'object' &&
      typeof (current as { code?: unknown }).code === 'string' &&
      /^[0-9A-Z]{5}$/.test((current as { code: string }).code) &&
      'severity' in current
    ) {
      const { code, constraint, table } = current as unknown as {
        code: string;
        constraint?: string;
        table?: string;
      };
      return { code, ...(constraint ? { constraint } : {}), ...(table ? { table } : {}) };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Translates a database error into a DomainError.
 *
 * `constraints` maps constraint names to the domain error to raise, e.g.
 * `{ users_email_key: () => new ConflictError('USER_EMAIL_TAKEN', '...') }`.
 * This is how invariants enforced by the database (unique keys, exclusion
 * constraints) become precise, race-free business errors.
 *
 * Returns the original error when nothing matches (it then surfaces as INTERNAL).
 * Use as: `catch (e) { throw translateDbError(e, {...}) }`.
 */
export function translateDbError(
  error: unknown,
  constraints: Readonly<Record<string, () => DomainError>> = {},
): unknown {
  const info = pgErrorInfo(error);
  if (!info) return error;
  const mapped = info.constraint ? constraints[info.constraint] : undefined;
  if (mapped) return mapped();
  switch (info.code) {
    case PG_ERROR.SERIALIZATION_FAILURE:
    case PG_ERROR.DEADLOCK_DETECTED:
      return new ConcurrencyError(
        'TRANSACTION_CONFLICT',
        'concurrent modification, retry the request',
        {},
        { cause: error },
      );
    case PG_ERROR.QUERY_CANCELED:
      return new DependencyUnavailableError(
        'DATABASE_TIMEOUT',
        'database statement timed out',
        {},
        { cause: error },
      );
    default:
      return error;
  }
}
