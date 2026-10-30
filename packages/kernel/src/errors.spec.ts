import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  DomainError,
  isDomainError,
  NotFoundError,
  ValidationError,
} from './errors.ts';

describe('DomainError', () => {
  it('carries kind, reason, metadata and a subclass name', () => {
    const error = new NotFoundError('USER_NOT_FOUND', 'user 42 not found', { userId: '42' });
    expect(error).toBeInstanceOf(DomainError);
    expect(error.kind).toBe('NOT_FOUND');
    expect(error.reason).toBe('USER_NOT_FOUND');
    expect(error.metadata).toEqual({ userId: '42' });
    expect(error.name).toBe('NotFoundError');
    expect(isDomainError(error)).toBe(true);
    expect(isDomainError(new Error('x'))).toBe(false);
  });

  it('rejects reasons that are not UPPER_SNAKE_CASE', () => {
    expect(() => new ConflictError('email-taken', 'x')).toThrow(TypeError);
  });

  it('freezes metadata and violations', () => {
    const error = new ValidationError('bad input', [{ field: 'email', description: 'invalid' }]);
    expect(error.kind).toBe('INVALID_ARGUMENT');
    expect(error.reason).toBe('VALIDATION_FAILED');
    expect(Object.isFrozen(error.violations)).toBe(true);
    expect(Object.isFrozen(error.metadata)).toBe(true);
  });
});
