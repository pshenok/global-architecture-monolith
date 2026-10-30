import type { IncomingMessage, ServerResponse } from 'node:http';
import { clients } from './clients.ts';
import {
  BadRequest,
  escapeHtml,
  page,
  readBody,
  redirect,
  sendHtml,
  singleParams,
} from './http.ts';
import { issuer, MAX_ACCESS_TTL_S, randomToken } from './keys.ts';
import { CODE_TTL_MS, codes, TRANSACTION_TTL_MS, type Transaction, transactions } from './store.ts';

/**
 * GET/POST /authorize: the authorization code flow with PKCE, stricter than real
 * providers on purpose (S256 only, state and nonce required, exact redirect URIs,
 * unknown scopes refused), so a client's omissions fail locally rather than in prod.
 */

const SCOPES = new Set(['openid', 'email', 'offline_access']);
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const SUBJECT = /^[\x21-\x7e]{1,255}$/;
const DEFAULT_ACCESS_TTL_S = 300;
const MIN_ACCESS_TTL_S = 5;

const errorPage = (response: ServerResponse, message: string) =>
  sendHtml(
    response,
    400,
    page('Sign-in error', `<h1>Sign-in error</h1><p>${escapeHtml(message)}</p>`),
  );

/** CSP of the sign-in page: the form may only post here and follow the 303 to the client. */
function signInCsp(redirectUri: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `form-action 'self' ${new URL(redirectUri).origin}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

function signInForm(
  transactionId: string,
  transaction: Transaction,
  values: { sub?: string; email?: string; emailVerified?: boolean; accessTtlS?: string },
  error?: string,
): string {
  const client = escapeHtml(transaction.clientId);
  return page(
    'Sign in',
    `<h1>Sign in to ${client}</h1>
<p class="note">Local development IdP: it signs in whatever subject you enter.</p>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/authorize">
  <input type="hidden" name="txn" value="${escapeHtml(transactionId)}">
  <label for="sub">Subject (login id)</label>
  <input id="sub" name="sub" type="text" required maxlength="255" autocomplete="username" value="${escapeHtml(values.sub ?? '')}">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" maxlength="320" placeholder="empty: &lt;subject&gt;@example.com" value="${escapeHtml(values.email ?? '')}">
  <label class="inline"><input name="email_verified" type="checkbox" value="true"${values.emailVerified === false ? '' : ' checked'}> Email verified</label>
  <label for="access_ttl">Access token lifetime (seconds)</label>
  <input id="access_ttl" name="access_ttl" type="number" min="${MIN_ACCESS_TTL_S}" max="${MAX_ACCESS_TTL_S}" value="${escapeHtml(values.accessTtlS ?? String(DEFAULT_ACCESS_TTL_S))}">
  <div class="actions">
    <button type="submit" name="action" value="sign-in">Sign in</button>
    <button type="submit" name="action" value="cancel" formnovalidate>Cancel</button>
  </div>
</form>`,
  );
}

export function authorizeGet(request: IncomingMessage, response: ServerResponse) {
  const params = singleParams(new URL(request.url ?? '/', issuer).searchParams);
  const client = clients.get(params.get('client_id') ?? '');
  const redirectUri = params.get('redirect_uri') ?? '';
  // Before the redirect URI is known good, errors are shown here, never redirected.
  if (!client) return errorPage(response, 'Unknown client_id.');
  if (!client.redirectUris.includes(redirectUri)) {
    return errorPage(response, 'redirect_uri is not registered for this client.');
  }
  const state = params.get('state');
  const fail = (error: string, description: string) =>
    redirect(response, redirectUri, { error, error_description: description, state, iss: issuer });

  if (params.get('response_type') !== 'code') {
    return fail('unsupported_response_type', 'only response_type=code');
  }
  const scope = (params.get('scope') ?? '').split(' ').filter(Boolean);
  if (!scope.includes('openid')) return fail('invalid_scope', 'scope must include openid');
  const unknown = scope.find((s) => !SCOPES.has(s));
  if (unknown) return fail('invalid_scope', `unsupported scope ${unknown}`);
  if (params.get('code_challenge_method') !== 'S256') {
    return fail('invalid_request', 'code_challenge_method must be S256');
  }
  const codeChallenge = params.get('code_challenge') ?? '';
  if (!CODE_CHALLENGE.test(codeChallenge)) return fail('invalid_request', 'bad code_challenge');
  if (!state) return fail('invalid_request', 'state is required');
  const nonce = params.get('nonce');
  if (!nonce) return fail('invalid_request', 'nonce is required');

  const transaction: Transaction = {
    clientId: client.clientId,
    redirectUri,
    scope,
    state,
    nonce,
    codeChallenge,
  };
  // The transaction id is single use and unguessable: it is also the form's CSRF token.
  const transactionId = randomToken(16);
  transactions.set(transactionId, transaction, TRANSACTION_TTL_MS);
  const loginHint = params.get('login_hint');
  sendHtml(
    response,
    200,
    signInForm(transactionId, transaction, loginHint ? { sub: loginHint } : {}),
    signInCsp(redirectUri),
  );
}

export async function authorizePost(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!String(request.headers['content-type']).startsWith('application/x-www-form-urlencoded')) {
    throw new BadRequest('form expected');
  }
  const form = singleParams(new URLSearchParams(await readBody(request)));
  const transactionId = form.get('txn') ?? '';
  const transaction = transactions.get(transactionId);
  if (!transaction) return errorPage(response, 'This sign-in expired. Start again from the app.');

  const { redirectUri, state } = transaction;
  if (form.get('action') === 'cancel') {
    transactions.delete(transactionId);
    return redirect(response, redirectUri, { error: 'access_denied', state, iss: issuer });
  }

  const sub = (form.get('sub') ?? '').trim();
  const email = (form.get('email') ?? '').trim();
  const emailVerified = form.get('email_verified') === 'true';
  const accessTtlS = Number(form.get('access_ttl') ?? DEFAULT_ACCESS_TTL_S);
  const values = { sub, email, emailVerified, accessTtlS: form.get('access_ttl') ?? '' };
  const invalid = !SUBJECT.test(sub)
    ? 'Enter a subject: 1 to 255 visible ASCII characters, no spaces.'
    : email.length > 320 || (email !== '' && !email.includes('@'))
      ? 'Enter a valid email or leave it empty.'
      : !Number.isInteger(accessTtlS) ||
          accessTtlS < MIN_ACCESS_TTL_S ||
          accessTtlS > MAX_ACCESS_TTL_S
        ? `The lifetime is a whole number from ${MIN_ACCESS_TTL_S} to ${MAX_ACCESS_TTL_S}.`
        : undefined;
  if (invalid) {
    return sendHtml(
      response,
      400,
      signInForm(transactionId, transaction, values, invalid),
      signInCsp(redirectUri),
    );
  }

  transactions.delete(transactionId);
  const code = randomToken();
  codes.set(
    code,
    {
      clientId: transaction.clientId,
      redirectUri,
      codeChallenge: transaction.codeChallenge,
      nonce: transaction.nonce,
      scope: transaction.scope,
      identity: { sub, email: email || `${sub}@example.com`, emailVerified, accessTtlS },
      authTime: Math.floor(Date.now() / 1_000),
      sid: randomToken(16),
      used: false,
    },
    CODE_TTL_MS,
  );
  redirect(response, redirectUri, { code, state, iss: issuer });
}
