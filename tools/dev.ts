/**
 * Watch mode for one app (run from the app dir via `pnpm dev`):
 * SWC recompiles src -> dist on change, and `node --watch` restarts the process
 * when anything it imports changes, including workspace packages' dist.
 */
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './lib.ts';

const swc = join(ROOT, 'node_modules/.bin/swc');
const swcArgs = [
  'src',
  '-d',
  'dist',
  '--strip-leading-paths',
  '--config-file',
  join(ROOT, '.swcrc'),
  '--ignore',
  '**/*.spec.ts',
];

execFileSync(swc, swcArgs, { stdio: 'inherit' });
const children = [
  spawn(swc, [...swcArgs, '--watch'], { stdio: 'inherit' }),
  spawn(
    process.execPath,
    [
      '--watch',
      '--enable-source-maps',
      '--env-file-if-exists=.env',
      '--import',
      '@gam/platform/telemetry',
      'dist/main.js',
    ],
    { stdio: 'inherit' },
  ),
];
const stop = () => {
  for (const child of children) child.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children)
  child.on('exit', (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
