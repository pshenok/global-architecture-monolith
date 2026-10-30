import { ConcurrencyError, ConflictError, DependencyUnavailableError } from '@gam/kernel';
import { describe, expect, it } from 'vitest';
import { pgErrorInfo, translateDbError } from './pg-errors.ts';

function pgError(code: string, constraint?: string) {
  return Object.assign(new Error('pg'), { code, constraint, severity: 'ERROR', table: 'users' });
}

describe('pg error translation', () => {
  it('finds the driver error behind a wrapper', () => {
    const wrapped = new Error('Failed query', { cause: pgError('23505', 'users_email_key') });
    expect(pgErrorInfo(wrapped)).toEqual({
      code: '23505',
      constraint: 'users_email_key',
      table: 'users',
    });
    expect(pgErrorInfo(new Error('plain'))).toBeNull();
  });

  it('maps a named constraint to the given domain error', () => {
    const error = translateDbError(new Error('x', { cause: pgError('23505', 'users_email_key') }), {
      users_email_key: () => new ConflictError('USER_EMAIL_TAKEN', 'email taken'),
    });
    expect(error).toBeInstanceOf(ConflictError);
  });

  it('maps serialization failures and timeouts, and leaves the rest untouched', () => {
    expect(translateDbError(pgError('40001'))).toBeInstanceOf(ConcurrencyError);
    expect(translateDbError(pgError('57014'))).toBeInstanceOf(DependencyUnavailableError);
    const other = pgError('42P01');
    expect(translateDbError(other)).toBe(other);
  });
});
