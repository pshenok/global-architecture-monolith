/**
 * Prints an access token from the local dev IdP (tools/dev-idp.ts, part of pnpm stack:up):
 *   pnpm dev:token <sub> [--email a@x.io] [--unverified] [--ttl 900]
 *   curl -H "authorization: Bearer $(pnpm -s dev:token alice --email alice@x.io)" ...
 */
import { parseArgs } from 'node:util';
import { readRegistry } from './lib.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: 'string' },
    unverified: { type: 'boolean', default: false },
    ttl: { type: 'string', default: '900' },
  },
});
const sub = positionals[0];
if (!sub) {
  console.error('usage: pnpm dev:token <sub> [--email a@x.io] [--unverified] [--ttl 900]');
  process.exit(1);
}
const response = await fetch(`http://127.0.0.1:${readRegistry().devIdp.port}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    sub,
    ...(values.email ? { email: values.email, emailVerified: !values.unverified } : {}),
    ttlS: Number(values.ttl),
  }),
}).catch(() => {
  console.error('dev-idp is not running: pnpm stack:up');
  process.exit(1);
});
const body = (await response.json()) as { access_token?: string; error_description?: string };
if (!body.access_token) {
  console.error(body.error_description ?? `dev-idp answered ${response.status}`);
  process.exit(1);
}
console.log(body.access_token);
