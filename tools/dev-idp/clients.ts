import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { type DevIdpClient, readRegistry } from '../lib.ts';

/** Clients registered for the code flow (modules.json devIdp.clients). */
export const clients: ReadonlyMap<string, DevIdpClient> = new Map(
  (readRegistry().devIdp.clients ?? []).map((client) => [client.clientId, client]),
);

const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * The client a token request authenticates as, with exactly one method:
 * client_secret_basic (credentials form-urlencoded, RFC 6749 section 2.3.1) or
 * client_secret_post. Undefined means invalid_client.
 */
export function authenticateClient(
  request: IncomingMessage,
  form: Map<string, string>,
): DevIdpClient | undefined {
  const header = request.headers.authorization;
  const basic = header?.match(/^Basic\s+(\S+)$/i)?.[1];
  const posted = form.get('client_secret');
  if ((basic !== undefined) === (posted !== undefined)) return undefined;
  let id: string | undefined;
  let secret: string | undefined;
  if (basic !== undefined) {
    const decoded = Buffer.from(basic, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return undefined;
    try {
      id = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' '));
      secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' '));
    } catch {
      return undefined;
    }
    if (form.has('client_id') && form.get('client_id') !== id) return undefined;
  } else {
    id = form.get('client_id');
    secret = posted;
  }
  const client = id === undefined ? undefined : clients.get(id);
  if (!client || secret === undefined || !equal(secret, client.clientSecret)) return undefined;
  return client;
}
