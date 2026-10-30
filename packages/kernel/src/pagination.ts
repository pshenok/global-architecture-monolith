import { ValidationError } from './errors.ts';

/**
 * Keyset pagination (AIP-158). Lists are ordered newest first by UUIDv7 id, so the
 * cursor is simply the last id of the previous page. The cursor travels to clients
 * as an opaque `page_token` that also binds the filter it was issued for.
 */
export interface PageRequest {
  /** Number of items to return, already clamped by {@link resolvePageSize}. */
  readonly limit: number;
  /** Return items with id strictly lower than this one (older), or from the start when null. */
  readonly after: string | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Id to continue after, or null when this is the last page. */
  readonly nextAfter: string | null;
}

export interface PageSizeLimits {
  readonly default: number;
  readonly max: number;
}

export const DEFAULT_PAGE_SIZE: PageSizeLimits = { default: 20, max: 100 };

/** AIP-158: 0 means "server default", above max is coerced down, negative is an error. */
export function resolvePageSize(
  requested: number,
  limits: PageSizeLimits = DEFAULT_PAGE_SIZE,
): number {
  if (!Number.isInteger(requested) || requested < 0) {
    throw new ValidationError('page_size must be a non-negative integer', [
      { field: 'pageSize', description: 'must be a non-negative integer' },
    ]);
  }
  if (requested === 0) return limits.default;
  return Math.min(requested, limits.max);
}

interface TokenPayload {
  readonly v: 1;
  readonly a: string;
  readonly f: string;
}

/** Stable fingerprint of the filter a token was issued for, so a token cannot be reused with another filter. */
export function filterFingerprint(
  filter: Record<string, string | number | boolean | null | undefined>,
): string {
  const entries = Object.entries(filter)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

export function encodePageToken(after: string, fingerprint: string): string {
  const payload: TokenPayload = { v: 1, a: after, f: fingerprint };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Returns the cursor for a token, or null for an empty token. Throws ValidationError on a bad or mismatched token. */
export function decodePageToken(token: string, fingerprint: string): string | null {
  if (token === '') return null;
  const invalid = () =>
    new ValidationError(
      'page_token is invalid or was issued for different filters',
      [{ field: 'pageToken', description: 'invalid page token' }],
      'INVALID_PAGE_TOKEN',
    );
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    (payload as TokenPayload).v !== 1 ||
    typeof (payload as TokenPayload).a !== 'string' ||
    (payload as TokenPayload).f !== fingerprint
  ) {
    throw invalid();
  }
  return (payload as TokenPayload).a;
}

/**
 * Turns `limit + 1` fetched rows into a page. Repositories fetch one extra row to
 * learn whether another page exists without a COUNT query.
 */
export function toPage<T extends { readonly id: string }>(
  rows: readonly T[],
  limit: number,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextAfter: hasMore && last ? last.id : null };
}
