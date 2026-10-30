/**
 * Module-boundary guardrail (ADR-0002), run by `pnpm lint`. The modules share one process
 * and one database; this keeps them apart the way separate services would be, so any of
 * them can move out later. Code is read with the TypeScript 7 parser
 * (`typescript/unstable/ast`, through the same project snapshot as tools/check-access.ts):
 * every import, re-export, `import()`, `import x = require()` and `import('x')` type of
 * every `.ts` file under apps/*\/{src,test}, modules/*\/{src,test}, packages/*\/{src,test}
 * and templates/*\/{src,test}.
 *
 * 1. Packages. A module (modules.json) depends on @gam/kernel, @gam/platform and other
 *    modules only; packages/* on no module or app; nothing on an app. Module dependencies
 *    form a DAG (a reaction that would go "backwards" is an event).
 * 2. Imports. A workspace package is imported by its name only when the importer's
 *    package.json declares it. Another module is imported by its root only (its
 *    src/index.ts, the public API); only apps may use a module's other exports (`/ops`).
 *    A relative import never leaves its own package.
 * 3. Data. A module's tables live in its own Postgres schema: its schema.ts declares
 *    `pgSchema('<its schema>')` (modules.json) and no `pgTable` (the public schema). Its
 *    source names no other module's schema, nor the platform's `events` schema, in an SQL
 *    string: other modules' data comes through their public API or their events.
 * 4. Registry. Every module of modules.json is a workspace package at its `dir`, named
 *    `package`, a dependency of the api app, and imported by the app's app.module.ts (it
 *    mounts it) and migrations.ts (it migrates it); every folder in modules/ is in
 *    modules.json.
 *
 * Every run first checks itself on the probes in modules/houses/test/boundary-probes,
 * read as houses' src: a line marked `// refused` must be refused, and no other line.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  type CallExpression,
  type ExportDeclaration,
  type ImportDeclaration,
  type ImportEqualsDeclaration,
  type ImportTypeNode,
  type LiteralTypeNode,
  type Node,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
} from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { ROOT, readRegistry } from './lib.ts';

interface Pkg {
  readonly name: string;
  readonly dir: string;
  readonly kind: 'app' | 'module' | 'package' | 'template';
  readonly dependencies: ReadonlySet<string>;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', 'drizzle']);
const registry = readRegistry();
const problems: string[] = [];

function* files(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.endsWith('.ts')) yield path;
  }
}

/** Workspace packages by name. */
function workspace(): Map<string, Pkg> {
  const packages = new Map<string, Pkg>();
  const kinds = { apps: 'app', modules: 'module', packages: 'package', templates: 'template' };
  for (const [top, kind] of Object.entries(kinds) as [string, Pkg['kind']][]) {
    if (!existsSync(join(ROOT, top))) continue;
    for (const entry of readdirSync(join(ROOT, top), { withFileTypes: true })) {
      const manifest = join(ROOT, top, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      packages.set(json.name, {
        name: json.name,
        dir: `${top}/${entry.name}`,
        kind,
        dependencies: new Set([
          ...Object.keys(json.dependencies ?? {}),
          ...Object.keys(json.devDependencies ?? {}),
        ]),
      });
    }
  }
  return packages;
}

const packages = workspace();
const byDir = new Map([...packages.values()].map((pkg) => [pkg.dir, pkg]));
const modules = new Set(
  [...packages.values()].filter((p) => p.kind === 'module').map((p) => p.name),
);

/** The workspace package a repository file belongs to. */
function packageOf(file: string): Pkg | undefined {
  const [top, name] = file.split('/');
  return byDir.get(`${top}/${name}`);
}

// ---- 1. Packages --------------------------------------------------------------------

function checkPackages(): void {
  for (const pkg of packages.values()) {
    for (const dependency of pkg.dependencies) {
      const target = packages.get(dependency);
      if (!target) continue;
      if (target.kind === 'app')
        problems.push(`${pkg.dir}/package.json: depends on the app ${dependency}`);
      if (target.kind === 'template') {
        problems.push(`${pkg.dir}/package.json: depends on the template ${dependency}`);
      }
      if (pkg.kind === 'package' && target.kind === 'module') {
        problems.push(
          `${pkg.dir}/package.json: a shared package depends on the module ${dependency}`,
        );
      }
    }
  }
  const cycle = moduleCycle(
    new Map(
      [...modules].map((name) => [
        name,
        [...(packages.get(name)?.dependencies ?? [])].filter((d) => modules.has(d)),
      ]),
    ),
  );
  if (cycle) problems.push(`module dependencies form a cycle: ${cycle.join(' -> ')}`);
}

/** A cycle in the graph, as the path that closes it; undefined for a DAG. */
function moduleCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const visit = (node: string): string[] | undefined => {
    if (state.get(node) === 'done') return undefined;
    if (state.get(node) === 'open') return [...path.slice(path.indexOf(node)), node];
    state.set(node, 'open');
    path.push(node);
    for (const next of graph.get(node) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    state.set(node, 'done');
    return undefined;
  };
  for (const node of graph.keys()) {
    const found = visit(node);
    if (found) return found;
  }
  return undefined;
}

// ---- 2. Imports and 3. Data ---------------------------------------------------------

const textOf = (node: Node | undefined): string | undefined =>
  node &&
  (node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
    ? (node as StringLiteral).text
    : undefined;

/** Every module specifier a file names, with the node to report it at. */
function specifiers(source: SourceFile): { text: string; node: Node }[] {
  const found: { text: string; node: Node }[] = [];
  const visit = (node: Node): void => {
    let specifier: Node | undefined;
    if (node.kind === SyntaxKind.ImportDeclaration) {
      specifier = (node as ImportDeclaration).moduleSpecifier;
    } else if (node.kind === SyntaxKind.ExportDeclaration) {
      specifier = (node as ExportDeclaration).moduleSpecifier;
    } else if (node.kind === SyntaxKind.ImportEqualsDeclaration) {
      const reference = (node as ImportEqualsDeclaration).moduleReference as unknown as {
        kind: SyntaxKind;
        expression?: Node;
      };
      if (reference.kind === SyntaxKind.ExternalModuleReference) specifier = reference.expression;
    } else if (node.kind === SyntaxKind.ImportType) {
      const argument = (node as ImportTypeNode).argument as LiteralTypeNode;
      specifier = argument.kind === SyntaxKind.LiteralType ? argument.literal : undefined;
    } else if (node.kind === SyntaxKind.CallExpression) {
      const call = node as CallExpression;
      const callee = call.expression;
      if (
        callee.kind === SyntaxKind.ImportKeyword ||
        (callee.kind === SyntaxKind.Identifier && callee.getText() === 'require')
      ) {
        specifier = call.arguments[0];
      }
    }
    const text = textOf(specifier);
    if (specifier && text !== undefined) found.push({ text, node: specifier });
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return found;
}

/** Schema names a module's source may not use in SQL: the other modules' and the platform's. */
function foreignSchemas(own: string | undefined): string[] {
  return [...registry.modules.map((m) => m.schema), 'events', 'drizzle'].filter((s) => s !== own);
}

function checkFile(file: string, source: SourceFile, as = file): void {
  const at = (node: Node) =>
    `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const owner = packageOf(as);
  if (!owner) return;
  for (const { text, node } of specifiers(source)) {
    if (text.startsWith('.')) {
      const target = relative(ROOT, resolve(ROOT, dirname(as), text));
      if (target.startsWith('..') || packageOf(target.split(sep).join('/')) !== owner) {
        problems.push(
          `${at(node)}: a relative import leaves ${owner.dir} (${text}); import packages by name`,
        );
      }
      continue;
    }
    const match = /^(@gam\/[^/]+)(\/.*)?$/.exec(text);
    if (!match) continue;
    const [, name, subpath] = match as unknown as [string, string, string | undefined];
    const target = packages.get(name);
    if (!target) {
      problems.push(`${at(node)}: ${name} is not a workspace package`);
      continue;
    }
    if (target === owner) {
      problems.push(`${at(node)}: imports its own package by name; use a relative import`);
      continue;
    }
    if (!owner.dependencies.has(name)) {
      problems.push(
        `${at(node)}: imports ${name}, which ${owner.dir}/package.json does not declare`,
      );
    }
    if (target.kind === 'app') problems.push(`${at(node)}: imports the app ${name}`);
    if (target.kind === 'module' && owner.kind !== 'app' && subpath !== undefined) {
      problems.push(
        `${at(node)}: reaches into ${name}${subpath}; other modules import its root (src/index.ts) only`,
      );
    }
    if (owner.kind === 'package' && target.kind === 'module') {
      problems.push(`${at(node)}: a shared package imports the module ${name}`);
    }
  }
  if (owner.kind !== 'module' && owner.kind !== 'template') return;
  const own = registry.modules.find((m) => m.dir === owner.dir)?.schema ?? 'sample_items';
  const foreign = foreignSchemas(own);
  // An SQL reference is `schema.table` or `"schema"."table"` after a space, a parenthesis
  // or a comma; `houses.v1.` is an event type, `user-events.ts` a file name.
  const reference = new RegExp(`(?:^|[\\s(,])"?(${foreign.join('|')})"?\\."?(?!v\\d+\\.)[a-z_]`);
  const visit = (node: Node): void => {
    if (
      node.kind === SyntaxKind.StringLiteral ||
      node.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
      node.kind === SyntaxKind.TemplateHead ||
      node.kind === SyntaxKind.TemplateMiddle ||
      node.kind === SyntaxKind.TemplateTail
    ) {
      const hit = reference.exec((node as StringLiteral).text);
      if (hit) {
        problems.push(
          `${at(node)}: names the ${hit[1]} schema in SQL; other modules' data comes through their public API or events`,
        );
      }
    }
    node.forEachChild(visit);
  };
  if (/\/src\//.test(as)) source.forEachChild(visit);
}

function checkSchemaFiles(): void {
  for (const module of registry.modules) {
    const file = join(ROOT, module.dir, 'src/infrastructure/persistence/schema.ts');
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const schemas = [...text.matchAll(/pgSchema\(\s*'([^']*)'\s*\)/g)].map((m) => m[1]);
    if (schemas.length !== 1 || schemas[0] !== module.schema) {
      problems.push(
        `${module.dir}/src/infrastructure/persistence/schema.ts: declares pgSchema(${schemas.map((s) => `'${s}'`).join(', ') || 'none'}); a module keeps its tables in pgSchema('${module.schema}') only`,
      );
    }
    if (/\bpgTable\s*\(/.test(text)) {
      problems.push(
        `${module.dir}/src/infrastructure/persistence/schema.ts: pgTable puts a table in the public schema; use ${module.schema}Schema.table`,
      );
    }
  }
}

// ---- 4. Registry --------------------------------------------------------------------

function checkRegistry(read: (path: string) => SourceFile | undefined): void {
  const api = packages.get(registry.api.package);
  const imported = (file: string) => {
    const source = read(join(ROOT, registry.api.dir, file));
    if (!source) problems.push(`${registry.api.dir}/${file}: cannot be read`);
    return new Set(source ? specifiers(source).map(({ text }) => text) : []);
  };
  const mounted = imported('src/app.module.ts');
  const migrated = imported('src/migrations.ts');
  if (!api) problems.push(`modules.json: the api package ${registry.api.package} does not exist`);
  for (const module of registry.modules) {
    const pkg = byDir.get(module.dir);
    if (!pkg || pkg.name !== module.package || pkg.kind !== 'module') {
      problems.push(
        `modules.json: ${module.name} is not the workspace module ${module.package} at ${module.dir}`,
      );
    }
    if (api && !api.dependencies.has(module.package)) {
      problems.push(
        `${registry.api.dir}/package.json: does not depend on the module ${module.package}, so the app does not mount it`,
      );
    }
    if (!mounted.has(module.package)) {
      problems.push(
        `${registry.api.dir}/src/app.module.ts: does not import ${module.package}, so the app does not mount it`,
      );
    }
    if (!migrated.has(module.package)) {
      problems.push(
        `${registry.api.dir}/src/migrations.ts: does not import ${module.package}, so its migrations never apply`,
      );
    }
  }
  for (const name of modules) {
    if (!registry.modules.some((m) => m.package === name)) {
      problems.push(
        `${packages.get(name)?.dir}: a module that modules.json does not list (pnpm new:module registers one)`,
      );
    }
  }
}

// ---- Self-test ----------------------------------------------------------------------

const PROBES = {
  dir: 'modules/houses/test/boundary-probes',
  as: 'modules/houses/src/boundary-probes',
};

function selfTest(read: (path: string) => SourceFile | undefined): void {
  if (
    moduleCycle(
      new Map([
        ['a', ['b']],
        ['b', ['c']],
        ['c', []],
      ]),
    )
  ) {
    problems.push('check-boundaries self-test: a DAG reads as a cycle');
  }
  if (
    moduleCycle(
      new Map([
        ['a', ['b']],
        ['b', ['a']],
      ]),
    )?.join(' ') !== 'a b a'
  ) {
    problems.push('check-boundaries self-test: a cycle is not found');
  }
  for (const path of files(join(ROOT, PROBES.dir))) {
    const shown = relative(ROOT, path);
    const source = read(path);
    if (!source) {
      problems.push(`${shown}: check-boundaries self-test probe is not part of a tsconfig project`);
      continue;
    }
    const before = problems.length;
    checkFile(shown, source, join(PROBES.as, relative(join(ROOT, PROBES.dir), path)));
    const produced = problems.splice(before);
    const refused = new Map<number, string>();
    for (const problem of produced) {
      const line = Number(/^[^:]+:(\d+):/.exec(problem)?.[1]);
      if (line) refused.set(line, problem);
    }
    source.text.split('\n').forEach((text, index) => {
      const line = index + 1;
      const marked = /\/\/ refused\b/.test(text);
      if (marked && !refused.has(line)) {
        problems.push(
          `${shown}:${line}: check-boundaries self-test: this probe is no longer refused`,
        );
      } else if (!marked && refused.has(line)) {
        problems.push(
          `check-boundaries self-test: refuses a probe marked as fine: ${refused.get(line)}`,
        );
      }
    });
  }
}

// ---- Run ----------------------------------------------------------------------------

const configs = [...packages.values()]
  .map((pkg) => join(ROOT, pkg.dir, 'tsconfig.json'))
  .filter((config) => existsSync(config));
const api = new API({ cwd: ROOT });
try {
  const snapshot = api.updateSnapshot({ openProjects: configs });
  const read = (path: string) =>
    snapshot.getDefaultProjectForFile(path)?.program.getSourceFile(path);
  checkPackages();
  checkRegistry(read);
  checkSchemaFiles();
  for (const pkg of packages.values()) {
    for (const folder of ['src', 'test']) {
      for (const path of files(join(ROOT, pkg.dir, folder))) {
        const file = relative(ROOT, path).split(sep).join('/');
        if (file.startsWith(PROBES.dir)) continue;
        const source = read(path);
        if (!source) {
          problems.push(
            `${file}: not part of any tsconfig project, so check-boundaries cannot read it`,
          );
          continue;
        }
        checkFile(file, source);
      }
    }
  }
  selfTest(read);
} finally {
  api.close();
}

if (problems.length > 0) {
  console.error(
    `check-boundaries: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(
  `check-boundaries: ${modules.size} module(s), dependencies acyclic; imports through public APIs only; each module in its own schema`,
);
