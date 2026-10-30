import {
  decodePageToken,
  encodePageToken,
  filterFingerprint,
  type Page,
  type PageRequest,
  resolvePageSize,
  ValidationError,
} from '@gam/kernel';
import { z } from 'zod';

/** Shared REST building blocks. */
export const IdParam = z.uuid({ message: 'must be a UUID' });

export const PageQuery = z.object({
  pageSize: z.coerce
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(0)
    .describe('1..100; 0 or omitted = 20.'),
  pageToken: z.string().max(512).default('').describe('nextPageToken of the previous page.'),
});

export const MoneyView = z
  .object({
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .describe('ISO 4217, e.g. USD'),
    amountMinor: z.number().int().nonnegative().describe('Minor units, e.g. 12550 = 125.50 USD'),
  })
  .meta({ id: 'Money' });

/** `{ items, nextPageToken }` envelope of every list endpoint. */
export const pageOf = <T extends z.ZodType>(item: T, id: string) =>
  z
    .object({
      items: z.array(item),
      nextPageToken: z
        .string()
        .nullable()
        .describe('Pass as pageToken to get the next page; null on the last page.'),
    })
    .meta({ id });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keyset paging of a list route: the page request for the repository, and the token of the
 * next page. The token binds `filter`, so it cannot be reused with other filters, and its
 * cursor must be an id (a crafted token is a 400, never a failed query).
 *
 *   const paging = keysetPaging(query, { ownerId, city });
 *   const page = await this.houses.list(filter, paging.request);
 *   return { items: page.items.map(toHouseView), nextPageToken: paging.next(page) };
 */
export function keysetPaging(
  query: { readonly pageSize: number; readonly pageToken: string },
  filter: Record<string, string | number | boolean | null | undefined> = {},
): { readonly request: PageRequest; next(page: Page<unknown>): string | null } {
  const fingerprint = filterFingerprint(filter);
  const after = decodePageToken(query.pageToken, fingerprint);
  if (after !== null && !UUID.test(after)) {
    throw new ValidationError(
      'page_token is invalid or was issued for different filters',
      [{ field: 'pageToken', description: 'invalid page token' }],
      'INVALID_PAGE_TOKEN',
    );
  }
  return {
    request: { limit: resolvePageSize(query.pageSize), after },
    next: (page) => (page.nextAfter ? encodePageToken(page.nextAfter, fingerprint) : null),
  };
}
