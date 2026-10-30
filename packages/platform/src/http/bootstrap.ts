import { readFileSync } from 'node:fs';
import { constants as http2 } from 'node:http2';
import type { AbstractHttpAdapter } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { docsEnabled, type HttpConfig } from '../config/config.ts';
import { requestIdFromHttp } from '../context/request-context.ts';
import { setupOpenApi } from './openapi.ts';
import { ProblemDetailsFilter } from './problem-details.ts';
import { http2StreamOf, isPastDeadline, RequestDeadlineInterceptor } from './request-deadline.ts';
import { validationPipe } from './validation.ts';

/** Fastify adapter: HTTPS with HTTP/2 and HTTP/1.1 fallback (ALPN), request ids, body limit. */
export function createAdapter(config: HttpConfig): AbstractHttpAdapter {
  const common = {
    logger: false,
    genReqId: requestIdFromHttp,
    bodyLimit: config.BODY_LIMIT_BYTES,
    trustProxy: config.TRUST_PROXY,
    // Node applies requestTimeout only to a plain HTTP/1 server (TLS off). handlerTimeout is
    // Fastify's own deadline per request, from routing through upload and handler, so HTTP/2
    // and HTTP/1.1 over TLS get one too. configureApp turns it into a 504 and frees the
    // request when it fires.
    requestTimeout: config.REQUEST_TIMEOUT_MS,
    handlerTimeout: config.REQUEST_TIMEOUT_MS,
  };
  if (!config.TLS_ENABLED) return new FastifyAdapter(common);
  let key: Buffer;
  let cert: Buffer;
  try {
    key = readFileSync(config.TLS_KEY_FILE);
    cert = readFileSync(config.TLS_CERT_FILE);
  } catch (error) {
    throw new Error(
      `TLS is enabled but ${config.TLS_CERT_FILE} / ${config.TLS_KEY_FILE} cannot be read. Run \`pnpm certs\` or set TLS_ENABLED=false behind a TLS proxy. (${String(error)})`,
    );
  }
  // HTTP/2 server types differ from the default HTTP/1 ones; Nest handles both at runtime.
  const options = { ...common, http2: true, https: { allowHTTP1: true, key, cert } };
  return new FastifyAdapter(options);
}

/** Everything that turns a Nest app into the HTTP API. Shared by main.ts and the tests. */
export function configureApp(app: NestFastifyApplication, config: HttpConfig): void {
  app.useLogger(app.get(Logger));
  // Strict Helmet-style defaults for every response; /docs relaxes its own CSP (see setupOpenApi).
  app.useSecurityHeaders();
  const origins = config.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length > 0)
    app.enableCors({
      origin: origins,
      exposedHeaders: ['x-request-id', 'location', 'www-authenticate'],
    });
  app.useGlobalPipes(validationPipe);
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalInterceptors(new RequestDeadlineInterceptor());
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
    // A request past its deadline may still be uploading, and without this its stream and
    // buffered body stay open as long as the client keeps trickling bytes. HTTP/1.1: the
    // connection closes after the 504. HTTP/2 (RFC 9113 section 8.1): once the 504 is out the
    // server stops the upload with RST_STREAM(NO_ERROR). The stream's own 'finish' is the
    // moment: the response's 'finish' (and so onResponse) waits for the stream to close.
    if (!isPastDeadline(request) || request.raw.complete) return;
    const stream = http2StreamOf(request);
    if (stream) stream.once('finish', () => stream.close(http2.NGHTTP2_NO_ERROR));
    else void reply.header('connection', 'close');
  });
  if (docsEnabled(config)) setupOpenApi(app);
  app.enableShutdownHooks();
}
