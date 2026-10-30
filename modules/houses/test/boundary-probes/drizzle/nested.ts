/**
 * Self-test of tools/check-boundaries.ts: a folder named drizzle inside src/ is code, and
 * is checked like any other (only a package's own migrations folder is skipped).
 */
export const nested = 'select * from users.users'; // refused
