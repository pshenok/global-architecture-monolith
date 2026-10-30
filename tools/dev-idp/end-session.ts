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
import { issuer, verifyIdTokenHint } from './keys.ts';
import { revoke } from './token.ts';

/**
 * GET|POST /end-session (OIDC RP-Initiated Logout 1.0): revokes the login's refresh
 * family, then returns to a registered post-logout URI or shows a signed-out page.
 */
export async function endSession(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let params: Map<string, string>;
  if (request.method === 'POST') {
    if (!String(request.headers['content-type']).startsWith('application/x-www-form-urlencoded')) {
      throw new BadRequest('form expected');
    }
    params = singleParams(new URLSearchParams(await readBody(request)));
  } else {
    params = singleParams(new URL(request.url ?? '/', issuer).searchParams);
  }
  const fail = (message: string) =>
    sendHtml(
      response,
      400,
      page('Sign-out error', `<h1>Sign-out error</h1><p>${escapeHtml(message)}</p>`),
    );

  let clientId = params.get('client_id');
  let sid: string | undefined;
  const hint = params.get('id_token_hint');
  if (hint) {
    const claims = await verifyIdTokenHint(hint).catch(() => undefined);
    if (!claims) return fail('id_token_hint was not issued here.');
    const audience = typeof claims.aud === 'string' ? claims.aud : undefined;
    if (clientId !== undefined && clientId !== audience) {
      return fail('client_id does not match id_token_hint.');
    }
    clientId = audience;
    sid = typeof claims.sid === 'string' ? claims.sid : undefined;
  }
  const client = clientId === undefined ? undefined : clients.get(clientId);
  const target = params.get('post_logout_redirect_uri');
  if (target !== undefined) {
    if (!client) return fail('post_logout_redirect_uri needs id_token_hint or client_id.');
    if (!client.postLogoutRedirectUris.includes(target)) {
      return fail('post_logout_redirect_uri is not registered for this client.');
    }
  }

  if (sid !== undefined) revoke(sid);
  if (target !== undefined) return redirect(response, target, { state: params.get('state') });
  sendHtml(response, 200, page('Signed out', '<h1>Signed out</h1><p>You can close this tab.</p>'));
}
