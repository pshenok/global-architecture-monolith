/**
 * Local stack lifecycle (PM2 + local Postgres).
 *   pnpm stack:up     build -> .env files -> certificate -> db:setup -> migrations -> PM2 -> wait until ready
 *   pnpm stack:down   stop and remove the PM2 processes
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Agent, request } from 'undici';
import { ensureEnvFiles } from './env-files.ts';
import { databaseUrl, ROOT, readRegistry } from './lib.ts';

const run = (args: string[], cwd = ROOT, env: NodeJS.ProcessEnv = process.env) => {
  console.log(`\n$ ${args.join(' ')}`);
  execFileSync(args[0] as string, args.slice(1), { cwd, env, stdio: 'inherit' });
};
const pm2 = (...args: string[]) => run(['pnpm', 'exec', 'pm2', ...args]);

/** Runs the app's built migrate.js with the DATABASE_URL the stack uses (not its .env). */
function migrate(): void {
  const { api } = readRegistry();
  run([process.execPath, 'dist/migrate.js'], join(ROOT, api.dir), {
    ...process.env,
    DATABASE_URL: databaseUrl(api.database),
  });
}

async function waitUntilReady(): Promise<boolean> {
  const { api } = readRegistry();
  const base = `https://localhost:${api.httpsPort}`;
  const dispatcher = new Agent({
    connect: { ca: readFileSync(join(ROOT, '.certs/dev-ca.pem')) },
  });
  const deadline = Date.now() + 60_000;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await request(`${base}/readyz`, { dispatcher });
      const body = (await response.body.json()) as { status?: string };
      last = JSON.stringify({ httpStatus: response.statusCode, ...body });
      // Ready before the IdP keys load (public routes work); the stack waits for
      // `status: "ok"`: the database answered and the identity provider's keys are in.
      if (response.statusCode === 200 && body.status === 'ok') {
        console.log(`\nstack ready: ${last}`);
        console.log(`\n  API      ${base}/v1/...`);
        console.log(`  Docs     ${base}/docs`);
        console.log(`  OpenAPI  ${base}/openapi.json`);
        console.log('\n  pnpm stack:status | pnpm stack:logs | pnpm stack:down | pnpm test:e2e');
        return true;
      }
    } catch (error) {
      last = String(error);
    }
    await sleep(1_000);
  }
  console.error(
    `\nstack did not become ready within 60s; last state: ${last}\nsee: pnpm stack:logs`,
  );
  return false;
}

const command = process.argv[2];
switch (command) {
  case 'down':
    pm2('delete', 'ecosystem.config.cjs');
    break;
  case 'migrate':
    migrate();
    break;
  case 'up': {
    run(['pnpm', 'turbo', 'run', 'build']);
    const created = ensureEnvFiles();
    if (created.length > 0) console.log(`created ${created.join(', ')} from .env.example`);
    run([process.execPath, 'tools/dev-certs.ts']);
    run([process.execPath, 'tools/db-setup.ts']);
    migrate();
    pm2('startOrReload', 'ecosystem.config.cjs', '--update-env');
    const ready = await waitUntilReady();
    process.exit(ready ? 0 : 1);
    break;
  }
  default:
    console.error('usage: node tools/stack.ts up|down|migrate');
    process.exit(1);
}
