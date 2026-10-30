import { databaseConfigSchema, parseConfig, runMigrations } from '@gam/platform';
import { MIGRATIONS } from './migrations.ts';

/** Release step: `pnpm db:migrate` (locally) or a one-off job before rollout (in clusters). */
const config = parseConfig(databaseConfigSchema);
await runMigrations({ databaseUrl: config.DATABASE_URL, sets: MIGRATIONS });
console.log(`api: migrations applied (${MIGRATIONS.map((set) => set.name).join(', ')})`);
