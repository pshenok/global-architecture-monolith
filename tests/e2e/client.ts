import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Agent, request } from 'undici';

const ROOT = new URL('../../', import.meta.url);
const registry = JSON.parse(readFileSync(new URL('modules.json', ROOT), 'utf8')) as {
  api: { httpsPort: number };
  devIdp: { port: number };
};
export const BASE_URL = process.env.E2E_BASE_URL ?? `https://localhost:${registry.api.httpsPort}`;
export const CA = readFileSync(new URL('.certs/dev-cert.pem', ROOT));
/** The stack's local OIDC provider (tools/dev-idp.ts). */
export const IDP_URL = `http://127.0.0.1:${registry.devIdp.port}`;

/** HTTPS client that trusts the local dev certificate and negotiates HTTP/2 when offered. */
const dispatcher = new Agent({ connect: { ca: CA }, allowH2: true });

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
}

export async function api<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const response = await request(`${BASE_URL}${path}`, {
    method,
    dispatcher,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.body.text();
  return {
    status: response.statusCode,
    headers: response.headers,
    body: (text ? JSON.parse(text) : undefined) as T,
  };
}

/** GET returning the raw body (for HTML pages). */
export async function raw(
  path: string,
): Promise<{ status: number; contentType: string; text: string }> {
  const response = await request(`${BASE_URL}${path}`, { dispatcher });
  return {
    status: response.statusCode,
    contentType: String(response.headers['content-type'] ?? ''),
    text: await response.body.text(),
  };
}

/** "YYYY-MM-DD" n days from today (UTC). */
export function day(n: number): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + n * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
}

export const unique = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** An access token from the dev IdP for login `sub`. */
export async function idpToken(
  sub: string,
  options: { email?: string; emailVerified?: boolean; ttlS?: number } = {},
): Promise<string> {
  const response = await fetch(`${IDP_URL}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub, ...options }),
  });
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`dev-idp refused a token for ${sub}`);
  return body.access_token;
}

export interface Session {
  readonly sub: string;
  readonly userId: string;
  readonly email: string;
  readonly token: string;
  call<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>>;
}

/** A new login at the dev IdP, registered as a user (POST /v1/users). */
export async function signUp(name: string): Promise<Session> {
  const sub = unique(name);
  const email = `${sub}@example.com`;
  const token = await idpToken(sub, { email, emailVerified: true });
  const registered = await api<{ id: string }>(
    'POST',
    '/v1/users',
    { fullName: name },
    bearer(token),
  );
  if (registered.status !== 201) {
    throw new Error(`registration failed: ${registered.status} ${JSON.stringify(registered.body)}`);
  }
  return {
    sub,
    email,
    token,
    userId: registered.body.id,
    call: (method, path, body) => api(method, path, body, bearer(token)),
  };
}

/**
 * Grants a platform role through the app's own role CLI. It applies to the session's
 * next request: the API reads roles on every request.
 */
export function grantAdmin(userId: string): void {
  execFileSync('pnpm', ['-s', 'users:grant-role', userId, 'admin'], {
    cwd: fileURLToPath(ROOT),
    stdio: 'pipe',
  });
}

/**
 * Polls `check` until it returns without throwing, or the deadline passes (then its last
 * error is thrown). The one sanctioned wait in these tests: for eventually consistent
 * effects of events (ADR-0005), which arrive within a few seconds on the local stack.
 */
export async function eventually<T>(
  check: () => Promise<T>,
  { timeoutMs = 15_000, intervalMs = 200 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
