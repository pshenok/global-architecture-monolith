/**
 * Grants or revokes a platform role (ADR-0004). Roles live in the users module, never in
 * the identity provider. Runs against the app's database, like migrate.ts:
 *   pnpm users:grant-role <userId> admin [--by <name>]       (repo root, local stack)
 *   pnpm users:revoke-role <userId> admin [--by <name>]
 *   node dist/cli/role.js grant|revoke <userId> admin --by <name>   (DATABASE_URL set)
 * The change applies to the user's next request: the API reads roles on every request.
 * Each change prints one line naming who made it (`--by`, else the OS user the CLI runs
 * as); that line is the only record, so keep it (job log, ticket).
 */
import { createPool, databaseConfigSchema, parseConfig } from '@gam/platform';
import { changedBy, changeRole, parseRoleChange } from '@gam/users/ops';
import { drizzle } from 'drizzle-orm/node-postgres';

const change = parseRoleChange(process.argv.slice(2));
if (!change) {
  console.error('usage: role.js grant|revoke <userId> <role> [--by <name>]');
  process.exit(1);
}
// Before the transaction: nothing may fail once the change has committed.
const by = changedBy(change.by);

const pool = createPool(parseConfig(databaseConfigSchema), `api:${change.action}-role`);
try {
  const roles = await changeRole(drizzle({ client: pool }), change);
  console.log(
    `users: ${change.action} ${change.role} for user ${change.userId} by ${by}; roles now [${roles.join(', ')}]`,
  );
} finally {
  await pool.end();
}
