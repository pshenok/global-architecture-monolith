/**
 * Self-test of tools/check-access.ts: a folder named drizzle inside src/ is code, and is
 * checked like any other (only a package's own migrations folder is skipped).
 */
import type { UserActor } from '@gam/kernel';

export const nested = JSON.parse('{}') as UserActor; // refused
