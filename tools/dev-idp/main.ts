/**
 * A local OpenID Connect provider for development and the e2e suites (ADR-0004): the
 * API trusts it like any real IdP, so the stack needs no identity infrastructure.
 * It signs whatever subject it is asked for, which is exactly why it refuses to run
 * in production and only listens on loopback.
 *
 *   GET  /.well-known/openid-configuration, /jwks.json
 *   GET  /userinfo                       (Bearer: an access token it issued)
 *   POST /token  {"sub":"alice","email":"a@x.io","emailVerified":true,"ttlS":900}
 *                                        (JSON: mints an access token for the API)
 *   POST /rotate                         new signing key; old public keys stay published
 *
 * For browser clients (a BFF such as global-architecture-web), registered in
 * modules.json devIdp.clients:
 *   GET|POST /authorize                  code flow + PKCE S256; a sign-in form, no password
 *   POST /token  (form)                  authorization_code, refresh_token (rotating)
 *   GET|POST /end-session                RP-initiated logout; revokes the refresh family
 *
 * Keys: .certs/dev-idp.jwk.json. Port: modules.json devIdp.port. Codes and refresh
 * tokens live in memory: a restart ends web sessions at their next refresh.
 *   pnpm dev:token <sub> [--email a@x.io] [--unverified] [--ttl 900]
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { authorizeGet, authorizePost } from './authorize.ts';
import { endSession } from './end-session.ts';
import { BadRequest, sendJson } from './http.ts';
import { issuer, port, publicKeys, rotate, verifyAccessToken } from './keys.ts';
import { token } from './token.ts';

if (process.env.NODE_ENV === 'production') {
  console.error('dev-idp signs any subject it is asked for; it never runs in production');
  process.exit(1);
}

const ALLOWED_HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

const discovery = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  userinfo_endpoint: `${issuer}/userinfo`,
  jwks_uri: `${issuer}/jwks.json`,
  end_session_endpoint: `${issuer}/end-session`,
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  scopes_supported: ['openid', 'email', 'offline_access'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['ES256'],
  claims_supported: [
    'iss',
    'sub',
    'aud',
    'exp',
    'iat',
    'auth_time',
    'nonce',
    'sid',
    'email',
    'email_verified',
  ],
  authorization_response_iss_parameter_supported: true,
};

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // DNS rebinding guard: a browser page cannot reach this server under another name.
  if (!ALLOWED_HOSTS.has(request.headers.host ?? ''))
    return sendJson(response, 421, { error: 'host' });
  try {
    const route = `${request.method} ${request.url?.split('?')[0]}`;
    switch (route) {
      case 'GET /.well-known/openid-configuration':
        return sendJson(response, 200, discovery);
      case 'GET /jwks.json':
        return sendJson(response, 200, { keys: publicKeys() });
      case 'GET /userinfo': {
        const accessToken = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const payload = await verifyAccessToken(accessToken).catch(() => undefined);
        if (!payload) {
          response.setHeader('www-authenticate', 'Bearer error="invalid_token"');
          return sendJson(response, 401, { error: 'invalid_token' });
        }
        return sendJson(response, 200, {
          sub: payload.sub,
          ...(payload.email
            ? { email: payload.email, email_verified: payload.email_verified }
            : {}),
        });
      }
      case 'GET /authorize':
        return authorizeGet(request, response);
      case 'POST /authorize':
        return await authorizePost(request, response);
      case 'POST /token':
        return await token(request, response);
      case 'GET /end-session':
      case 'POST /end-session':
        return await endSession(request, response);
      case 'POST /rotate':
        return sendJson(response, 200, { kid: await rotate() });
      default:
        return sendJson(response, 404, { error: 'not_found' });
    }
  } catch (error) {
    if (!response.headersSent) {
      return sendJson(response, 400, {
        error: 'invalid_request',
        error_description: error instanceof BadRequest ? error.message : String(error),
      });
    }
  }
}

const server = createServer((request, response) => void handle(request, response));
server.listen(port, '127.0.0.1', () => console.log(`dev-idp issuing tokens as ${issuer}`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
