/**
 * CI guard against template rot: generates a throwaway multi-word module from
 * templates/module, mounts it in the app, then lints (Biome, check-access,
 * check-boundaries), typechecks, tests and builds it and the app, and removes it,
 * restoring the files it touched from a snapshot taken first (local edits included) and
 * building the app again, so its dist matches the restored sources.
 *   pnpm template:verify   (needs Postgres: `pnpm db:setup`)
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readRegistry } from './lib.ts';

const NAME = 'zz-template-check';
const PLURAL = 'zz-template-checks';
const PACKAGE = `@gam/${PLURAL}`;
const { api } = readRegistry();
const TOUCHED = [
  'modules.json',
  'pnpm-lock.yaml',
  `${api.dir}/package.json`,
  `${api.dir}/src/app.module.ts`,
  `${api.dir}/src/migrations.ts`,
];
const run = (args: string[]) => {
  console.log(`\n$ ${args.join(' ')}`);
  execFileSync(args[0] as string, args.slice(1), { cwd: ROOT, stdio: 'inherit' });
};
const status = () =>
  execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line && !line.includes(PLURAL))
    .sort()
    .join('\n');

const before = status();
const snapshot = new Map(TOUCHED.map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]));

let failed = false;
try {
  run([process.execPath, 'tools/new-module.ts', NAME]);
  run(['pnpm', 'exec', 'biome', 'ci', `modules/${PLURAL}`, api.dir, 'modules.json']);
  run(['pnpm', '--filter', PACKAGE, 'typecheck']);
  run(['pnpm', '--filter', PACKAGE, 'lint']);
  run([process.execPath, 'tools/check-access.ts']);
  run([process.execPath, 'tools/check-boundaries.ts']);
  run(['pnpm', '--filter', PACKAGE, 'test']);
  run(['pnpm', 'turbo', 'run', 'build', `--filter=${api.package}...`]);
  // The whole app with the new module: wiring, migrations, open routes, OpenAPI.
  run(['pnpm', '--filter', api.package, 'typecheck']);
  run(['pnpm', '--filter', api.package, 'test']);
  console.log('\ntemplate:verify OK');
} catch {
  failed = true;
  console.error('\ntemplate:verify FAILED');
} finally {
  rmSync(join(ROOT, 'modules', PLURAL), { recursive: true, force: true });
  for (const [file, text] of snapshot) writeFileSync(join(ROOT, file), text);
  run(['pnpm', 'install', '--prefer-offline', '--no-frozen-lockfile']);
  // The app was built with the throwaway module mounted: build it again from the restored
  // sources, or its dist (git-ignored, so the status check cannot see it) would import a
  // package that no longer exists.
  run(['pnpm', 'turbo', 'run', 'build', `--filter=${api.package}...`]);
}
const stale = readdirSync(join(ROOT, api.dir, 'dist'), { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.js'))
  .filter((file) => readFileSync(join(ROOT, api.dir, 'dist', file), 'utf8').includes(PACKAGE));
if (stale.length > 0) {
  console.error(`\ntemplate:verify left ${api.dir}/dist importing ${PACKAGE}: ${stale.join(', ')}`);
  failed = true;
}
const after = status();
if (after !== before) {
  console.error(`\ntemplate:verify left changes behind:\n${after}\n(before:\n${before})`);
  failed = true;
}
process.exit(failed ? 1 : 0);
