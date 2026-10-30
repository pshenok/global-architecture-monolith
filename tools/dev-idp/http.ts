import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 8_192;

export class BadRequest extends Error {}

export function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    request.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      if (text.length > MAX_BODY_BYTES) reject(new BadRequest('body too large'));
    });
    request.on('end', () => resolve(text));
    request.on('error', reject);
  });
}

/**
 * Query or form parameters, each at most once (RFC 6749 section 3.1). A repeated
 * parameter is an error, never "the first one wins".
 */
export function singleParams(source: URLSearchParams): Map<string, string> {
  const params = new Map<string, string>();
  for (const [key, value] of source) {
    if (params.has(key)) throw new BadRequest(`parameter ${key} repeated`);
    params.set(key, value);
  }
  return params;
}

export const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
};

export const sendHtml = (
  response: ServerResponse,
  status: number,
  html: string,
  csp = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
) => {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-security-policy': csp,
  });
  response.end(html);
};

/** 303 to `target` with `params` added to its query (authorization responses). */
export const redirect = (
  response: ServerResponse,
  target: string,
  params: Record<string, string | undefined> = {},
) => {
  const url = new URL(target);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  response.writeHead(303, { location: url.toString(), 'cache-control': 'no-store' });
  response.end();
};

export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - dev IdP</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 26rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
  p.note { color: GrayText; font-size: 0.875rem; margin-top: 0; }
  label { display: block; margin-top: 0.75rem; font-weight: 600; }
  label.inline { font-weight: 400; }
  input[type=text], input[type=email], input[type=number] { width: 100%; box-sizing: border-box; padding: 0.4rem; }
  .actions { display: flex; gap: 0.5rem; margin-top: 1.25rem; }
  button { padding: 0.45rem 1rem; }
  .error { color: #b3261e; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
