import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.ts';

/** Creates apps/<app>/.env from .env.example where missing (.env files are git-ignored). */
export function ensureEnvFiles(): string[] {
  const created: string[] = [];
  if (!existsSync(join(ROOT, 'apps'))) return created;
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const example = join(ROOT, 'apps', app, '.env.example');
    const env = join(ROOT, 'apps', app, '.env');
    if (existsSync(example) && !existsSync(env)) {
      copyFileSync(example, env);
      created.push(`apps/${app}/.env`);
    }
  }
  return created;
}
