/**
 * Self-test of tools/check-access.ts: a suppression of a layer rule, in a folder where the
 * rule applies (Biome's application-layer imports). Nothing imports or runs this file.
 */
// biome-ignore lint/style/noRestrictedImports: probe of the suppression rule // refused
import { sql } from 'drizzle-orm';

export const probe = sql;
