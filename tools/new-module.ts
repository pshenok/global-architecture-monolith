/**
 * Scaffolds a new feature module from templates/module and mounts it in the app.
 *
 *   pnpm new:module <noun> [--plural <noun>] [--no-register] [--skip-install]
 *
 * <noun> is the kebab-case domain noun, e.g. `review` or `payment-method`. Creates
 * modules/<plural> (package @gam/<plural>, Postgres schema <plural_snake>, routes
 * /v1/<plural>), its initial migration, and, unless --no-register, lists it in
 * modules.json and mounts it in apps/api (dependency, AppModule, migration sets).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { type ModuleEntry, ROOT, readRegistry, writeRegistry } from './lib.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    plural: { type: 'string' },
    'no-register': { type: 'boolean', default: false },
    'skip-install': { type: 'boolean', default: false },
  },
});

const KEBAB = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/;
const name = positionals[0];
if (!name || !KEBAB.test(name) || name.endsWith('-module')) {
  console.error('usage: pnpm new:module <kebab-case-noun> (e.g. review, payment-method)');
  process.exit(1);
}

function pluralize(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

const words = name.split('-');
if (values.plural && !KEBAB.test(values.plural)) {
  console.error('--plural must be kebab-case');
  process.exit(1);
}
const pluralWords = values.plural
  ? values.plural.split('-')
  : [...words.slice(0, -1), pluralize(words.at(-1) as string)];

const capitalize = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const forms = (ws: string[]) => ({
  kebab: ws.join('-'),
  snake: ws.join('_'),
  camel: (ws[0] as string) + ws.slice(1).map(capitalize).join(''),
  pascal: ws.map(capitalize).join(''),
  upper: ws.join('_').toUpperCase(),
  spaced: ws.join(' '),
});
const singular = forms(words);
const plural = forms(pluralWords);
if (plural.kebab === singular.kebab) {
  console.error('the plural must differ from the noun: pass --plural');
  process.exit(1);
}
const TEMPLATE = { singular: forms(['sample', 'item']), plural: forms(['sample', 'items']) };

// Plural forms first: they contain the singular forms as prefixes.
const replacements: [string, string][] = [];
for (const key of ['kebab', 'snake', 'camel', 'pascal', 'upper', 'spaced'] as const) {
  replacements.push([TEMPLATE.plural[key], plural[key]]);
}
for (const key of ['kebab', 'snake', 'camel', 'pascal', 'upper', 'spaced'] as const) {
  replacements.push([TEMPLATE.singular[key], singular[key]]);
}
const substitute = (text: string): string => {
  let out = text;
  for (const [from, to] of replacements) out = out.split(from).join(to);
  return out;
};

const registry = readRegistry();
const entry: ModuleEntry = {
  name: plural.kebab,
  dir: `modules/${plural.kebab}`,
  package: `@gam/${plural.kebab}`,
  schema: plural.snake,
};
const moduleDir = join(ROOT, entry.dir);
if (existsSync(moduleDir)) throw new Error(`${entry.dir} already exists`);
if (registry.modules.some((m) => m.name === entry.name || m.schema === entry.schema)) {
  throw new Error(`a module named ${entry.name} (or with schema ${entry.schema}) exists`);
}
if (
  ['events', 'drizzle', 'public', 'sample_items'].includes(entry.schema) ||
  /^pg_/.test(entry.schema)
) {
  throw new Error(`${entry.schema} is a reserved schema name (or the template's own)`);
}
/** Words the template's identifiers (`const sampleItem`, `sampleItems`) cannot take. */
const RESERVED = new Set(
  (
    'arguments await break case catch class const continue debugger default delete do else ' +
    'enum eval export extends false finally for function if implements import in instanceof ' +
    'interface let new null package private protected public return static super switch this ' +
    'throw true try typeof var void while with yield'
  ).split(' '),
);
for (const word of [singular.camel, plural.camel]) {
  if (RESERVED.has(word)) {
    throw new Error(`"${word}" is a reserved word in JavaScript: pick another noun`);
  }
}

const APP_MODULE = `${registry.api.dir}/src/app.module.ts`;
const APP_MIGRATIONS = `${registry.api.dir}/src/migrations.ts`;
const MODULES_MARKER = '// pnpm new:module adds feature modules';
const MIGRATIONS_MARKER = '// pnpm new:module adds migration sets';
if (!values['no-register']) {
  for (const [file, marker] of [
    [APP_MODULE, MODULES_MARKER],
    [APP_MIGRATIONS, MIGRATIONS_MARKER],
  ] as const) {
    if (!(await readFile(join(ROOT, file), 'utf8')).includes(marker)) {
      throw new Error(`${file} lost its marker "${marker}": put it back first`);
    }
  }
}
/** Files this run changes, as they were: a failed run puts them back. */
const TOUCHED = [
  'modules.json',
  'pnpm-lock.yaml',
  `${registry.api.dir}/package.json`,
  APP_MODULE,
  APP_MIGRATIONS,
];
const snapshot = new Map(
  await Promise.all(
    TOUCHED.map(async (file) => [file, await readFile(join(ROOT, file), 'utf8')] as const),
  ),
);

const run = (command: string, args: string[]) => {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
};

try {
  const templateDir = join(ROOT, 'templates/module');
  const SKIP = /^(?:node_modules|dist|drizzle|\.turbo|coverage)(?:\/|$)/;
  const files = (await readdir(templateDir, { recursive: true, withFileTypes: true }))
    .filter((file) => file.isFile())
    .map((file) => relative(templateDir, join(file.parentPath, file.name)))
    .filter((file) => !SKIP.test(file));
  for (const file of files) {
    const target = join(moduleDir, substitute(file));
    await mkdir(dirname(target), { recursive: true });
    const text = await readFile(join(templateDir, file), 'utf8');
    await writeFile(
      target,
      substitute(
        file === 'package.json'
          ? text.replace(
              'Sample items module (generated from templates/module by pnpm new:module).',
              `${capitalize(plural.spaced)} module.`,
            )
          : text,
      ),
    );
  }

  /** Inserts `line` above the marker comment in a file of the app. */
  async function insertAbove(file: string, marker: string, line: string): Promise<void> {
    const path = join(ROOT, file);
    const text = await readFile(path, 'utf8');
    const index = text.indexOf(marker);
    if (index < 0) throw new Error(`${file} lost its marker "${marker.trim()}"`);
    const lineStart = text.lastIndexOf('\n', index) + 1;
    await writeFile(path, `${text.slice(0, lineStart)}${line}\n${text.slice(lineStart)}`);
  }

  async function prependImport(file: string, line: string): Promise<void> {
    const path = join(ROOT, file);
    await writeFile(path, `${line}\n${await readFile(path, 'utf8')}`);
  }

  if (!values['no-register']) {
    registry.modules.push(entry);
    writeRegistry(registry);
    const apiPackage = join(ROOT, registry.api.dir, 'package.json');
    const manifest = JSON.parse(await readFile(apiPackage, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies[entry.package] = 'workspace:*';
    manifest.dependencies = Object.fromEntries(
      Object.entries(manifest.dependencies).sort(([a], [b]) => a.localeCompare(b)),
    );
    await writeFile(apiPackage, `${JSON.stringify(manifest, null, 2)}\n`);
    await prependImport(APP_MODULE, `import { ${plural.pascal}Module } from '${entry.package}';`);
    await insertAbove(APP_MODULE, MODULES_MARKER, `    ${plural.pascal}Module,`);
    await prependImport(
      APP_MIGRATIONS,
      `import { ${plural.upper}_MIGRATIONS } from '${entry.package}';`,
    );
    await insertAbove(APP_MIGRATIONS, MIGRATIONS_MARKER, `  ${plural.upper}_MIGRATIONS,`);
  }

  if (!values['skip-install']) {
    run('pnpm', ['install', '--prefer-offline', '--no-frozen-lockfile']);
    run('pnpm', ['--filter', entry.package, 'db:generate', '--name', 'init']);
  }
  // Renames change line lengths and import order: let Biome restore the canonical format.
  run('pnpm', [
    'exec',
    'biome',
    'check',
    '--write',
    entry.dir,
    ...(values['no-register'] ? [] : ['modules.json', registry.api.dir]),
  ]);
} catch (error) {
  // Leave nothing half-made: the module folder goes, the app's files come back.
  console.error(`\nnew:module failed, rolling back: ${String(error)}`);
  await rm(moduleDir, { recursive: true, force: true });
  for (const [file, text] of snapshot) await writeFile(join(ROOT, file), text);
  if (!values['skip-install']) {
    try {
      run('pnpm', ['install', '--prefer-offline', '--no-frozen-lockfile']);
    } catch {
      console.error('pnpm install after the rollback failed: run it yourself');
    }
  }
  process.exit(1);
}

console.log(`
Created ${entry.package}
  module    ${entry.dir} (Nest module ${plural.pascal}Module)
  routes    /v1/${plural.kebab}
  schema    ${entry.schema} (migrations ${plural.upper}_MIGRATIONS)
${values['no-register'] ? '  not mounted (--no-register)\n' : `  mounted in ${registry.api.dir} (AppModule, migrations)\n`}
Next (the gam-new-module skill has the details):
  1. Domain + use cases: src/domain/${singular.kebab}.ts, ${singular.kebab}.errors.ts, src/application/
  2. Persistence: edit schema.ts, then rm -r ${entry.dir}/drizzle && pnpm --filter ${entry.package} db:generate --name init
  3. HTTP: src/transport/http/ (schemas, controller with @Access on every route)
  4. Other modules: gam-module-communication (public API, ports, events)
  5. Tests: pnpm --filter ${entry.package} test, then pnpm --filter @gam/api test
`);
