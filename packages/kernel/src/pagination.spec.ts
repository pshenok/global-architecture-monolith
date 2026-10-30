import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors.ts';
import {
  decodePageToken,
  encodePageToken,
  filterFingerprint,
  resolvePageSize,
  toPage,
} from './pagination.ts';

describe('resolvePageSize', () => {
  it('uses the default for 0 and clamps to the max', () => {
    expect(resolvePageSize(0)).toBe(20);
    expect(resolvePageSize(5)).toBe(5);
    expect(resolvePageSize(1_000_000)).toBe(100);
  });

  it('rejects negative and fractional sizes', () => {
    expect(() => resolvePageSize(-1)).toThrow(ValidationError);
    expect(() => resolvePageSize(1.5)).toThrow(ValidationError);
  });
});

describe('page tokens', () => {
  const fp = filterFingerprint({ ownerId: 'u1', city: undefined });

  it('round-trips a cursor', () => {
    expect(decodePageToken(encodePageToken('id-9', fp), fp)).toBe('id-9');
    expect(decodePageToken('', fp)).toBeNull();
  });

  it('ignores empty filter values and key order in the fingerprint', () => {
    expect(filterFingerprint({ b: '2', a: '1', c: '' })).toBe(
      filterFingerprint({ a: '1', b: '2' }),
    );
  });

  it('rejects garbage and tokens issued for another filter', () => {
    expect(() => decodePageToken('not-a-token', fp)).toThrow(ValidationError);
    const other = encodePageToken('id-9', filterFingerprint({ ownerId: 'u2' }));
    expect(() => decodePageToken(other, fp)).toThrow(/different filters/);
  });
});

describe('toPage', () => {
  const rows = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];

  it('returns a cursor when more rows than the limit were fetched', () => {
    expect(toPage(rows, 2)).toEqual({ items: [{ id: 'c' }, { id: 'b' }], nextAfter: 'b' });
  });

  it('returns no cursor on the last page', () => {
    expect(toPage(rows, 3)).toEqual({ items: rows, nextAfter: null });
  });
});
