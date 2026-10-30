import { platformConfigSchema, withPlatformChecks } from '@gam/platform';
import type { z } from 'zod';

/**
 * Environment of the app, validated at boot: the platform's variables (HTTP, database,
 * authentication, events). Add app-specific ones with `.extend()` before the checks, and
 * to .env.example.
 */
export const ConfigSchema = withPlatformChecks(platformConfigSchema);

export type Config = z.output<typeof ConfigSchema>;
