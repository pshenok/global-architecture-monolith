import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A route callable without a registered user, read from the metadata the app carries. */
export interface DeclaredOpenEndpoint {
  /** `Class.method`. */
  readonly member: string;
  readonly access: 'public' | 'identity';
  readonly reason: string;
}

interface ListedEndpoint {
  readonly where: string;
  readonly access: string;
  readonly reason: string;
}

const LIST = join('security', 'public-endpoints.json');
/**
 * The repository root, from this file's own place (packages/platform/{src,dist}/testing),
 * never from the working directory: a list planted closer to a test cannot stand in for
 * the reviewed one.
 */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const describe = (entry: { access: string; reason: string }, member: string) =>
  `${member} [${entry.access}] ${entry.reason}`;

/**
 * Throws unless `declared` (the open routes the whole app recorded at boot and enforces)
 * matches what security/public-endpoints.json lists. tools/check-access.ts compares the
 * same list with the source; this check sees the metadata itself, whatever wrote it
 * before boot.
 */
export function expectListedOpenEndpoints(
  declared: readonly DeclaredOpenEndpoint[],
  root = ROOT,
): void {
  if (!existsSync(join(root, LIST))) throw new Error(`${join(root, LIST)} is missing`);
  const listed = (
    JSON.parse(readFileSync(join(root, LIST), 'utf8')) as { endpoints: ListedEndpoint[] }
  ).endpoints
    .map((entry) => describe(entry, entry.where.slice(entry.where.indexOf('#') + 1)))
    .sort();
  const actual = declared.map((entry) => describe(entry, entry.member)).sort();
  const missing = minus(actual, listed);
  const stale = minus(listed, actual);
  if (missing.length === 0 && stale.length === 0) return;
  throw new Error(
    [
      `${LIST} does not match what the app declares at runtime (ADR-0004):`,
      ...missing.map((entry) => `  open but not listed: ${entry}`),
      ...stale.map((entry) => `  listed but not open: ${entry}`),
      'Declare access with a direct @Access.<kind> decorator and list it with the same reason.',
    ].join('\n'),
  );
}

/** Entries of `a` that `b` does not match one for one. */
function minus(a: readonly string[], b: readonly string[]): string[] {
  const unmatched = [...b];
  return a.filter((entry) => {
    const index = unmatched.indexOf(entry);
    if (index < 0) return true;
    unmatched.splice(index, 1);
    return false;
  });
}
