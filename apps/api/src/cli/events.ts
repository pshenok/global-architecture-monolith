/**
 * Operator commands of the events (ADR-0005), against the app's database like migrate.ts:
 *   pnpm events:status                                                (repo root, local stack)
 *   pnpm events:redrive --subscriber <module> --type <event type>
 *   pnpm events:replay --subscriber <module> --type <event type> --since <ISO time>
 *   pnpm events:drop --subscriber <module> --type <event type>
 *   node dist/cli/events.js status|redrive|replay|drop ...            (DATABASE_URL set)
 * redrive makes the pair's dead letters due again; replay delivers its events since a time
 * again (or for the first time, to a module that subscribed later); drop discards its dead
 * letters, and its pending deliveries too once no module handles the pair (the dispatcher
 * leaves those alone). Run them from the build deployed everywhere: "handled" is what this
 * build's modules handle. Each change prints one line; keep it (job log, ticket), it is
 * the only record.
 * It boots no app: it reads which module handles which type from the modules themselves.
 */
import { parseArgs } from 'node:util';
import {
  createPool,
  databaseConfigSchema,
  EventsAdmin,
  eventCatalog,
  parseConfig,
  RETENTION_DAYS,
} from '@gam/platform';
import { drizzle } from 'drizzle-orm/node-postgres';
// Evaluates every module's EventsModule.forFeature: the catalog of who handles what.
// Nothing starts.
import '../app.module.ts';
import { parseSince } from './parse-since.ts';

const USAGE = `usage: events.js status
       events.js redrive --subscriber <module> --type <event type>
       events.js replay --subscriber <module> --type <event type> --since <ISO time>
       events.js drop --subscriber <module> --type <event type>`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    subscriber: { type: 'string' },
    type: { type: 'string' },
    since: { type: 'string' },
  },
});
const command = positionals[0];
const since = parseSince(values.since);
const pair = values.subscriber && values.type;
if (
  !(
    command === 'status' ||
    ((command === 'redrive' || command === 'drop') && pair) ||
    (command === 'replay' && pair && since)
  )
) {
  console.error(USAGE);
  process.exit(1);
}

const handled = new Set(eventCatalog().map((entry) => `${entry.subscriber} ${entry.type}`));
const isHandled = (subscriber: string, type: string) => handled.has(`${subscriber} ${type}`);

if (
  (command === 'replay' || command === 'redrive') &&
  !isHandled(values.subscriber as string, values.type as string)
) {
  console.error(
    `${values.subscriber} has no handler of ${values.type}: nothing to ${command} to (events:drop discards them)`,
  );
  process.exit(1);
}

const pool = createPool(parseConfig(databaseConfigSchema), `api:events-${command}`);
try {
  const admin = new EventsAdmin(drizzle({ client: pool }));
  const subscriber = values.subscriber as string;
  const type = values.type as string;
  if (command === 'status') {
    const rows = await admin.status();
    if (rows.length === 0) console.log('no deliveries');
    else
      console.table(
        rows.map((row) => ({
          ...row,
          handled: isHandled(row.subscriber, row.type) ? 'yes' : 'NO (events:drop them)',
        })),
      );
  } else if (command === 'redrive') {
    const count = await admin.redrive(subscriber, type);
    console.log(`events: redrove ${count} dead letter(s) of ${type} for ${subscriber}`);
  } else if (command === 'drop') {
    // A pair no module handles keeps its pending deliveries forever: drop those too.
    const retired = !isHandled(subscriber, type);
    const count = await admin.drop(subscriber, type, { retired });
    console.log(
      retired
        ? `events: dropped ${count} dead or pending delivery(ies) of ${type} for ${subscriber} (no module handles it)`
        : `events: dropped ${count} dead letter(s) of ${type} for ${subscriber}`,
    );
  } else {
    const from = since as Date;
    const oldest = EventsAdmin.oldestReplayable(new Date());
    const count = await admin.replay(subscriber, type, from);
    console.log(
      `events: queued ${count} ${type} event(s) since ${from.toISOString()} for ${subscriber}${from < oldest ? ` (events older than ${RETENTION_DAYS} days are gone)` : ''}`,
    );
  }
} finally {
  await pool.end();
}
