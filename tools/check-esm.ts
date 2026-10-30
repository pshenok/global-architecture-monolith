/**
 * Imports every built module of a package with real Node ESM linking.
 * Vitest's module runner does not validate named imports, so this is the guard
 * against a type imported as a value ("does not provide an export named X")
 * and against .ts specifiers that were not rewritten to .js.
 *
 * Usage (from a package dir): node ../../tools/check-esm.ts [dist]
 */
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = resolve(process.argv[2] ?? 'dist');
// Entrypoints run on import (servers, migrations, src/cli/ scripts); their imports are checked.
const skip = /(^|\/)(main|migrate)\.js$|(^|\/)cli\//;
const modules = (await readdir(dist, { recursive: true })).filter(
  (file) => file.endsWith('.js') && !skip.test(file),
);
for (const file of modules) await import(pathToFileURL(join(dist, file)).href);
console.log(`check-esm: ${modules.length} module(s) linked in ${dist}`);
