import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { z } from 'zod';
import { PUBLIC_EXTENSION } from '../auth/access.ts';
import { ProblemDetails } from './problem-details.ts';

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;
const PROBLEM_REF = '#/components/schemas/ProblemDetails';
/** How every error response is documented: the problem details the filter sends. */
const PROBLEM_CONTENT = { 'application/problem+json': { schema: { $ref: PROBLEM_REF } } };

type Response = { description?: string; content?: Record<string, { schema?: unknown }> };
type Operation = {
  security?: unknown[];
  responses?: Record<string, Response>;
  [PUBLIC_EXTENSION]?: boolean;
};

const isProblem = (response: Response) =>
  Object.values(response.content ?? {}).some(
    (media) => (media.schema as { $ref?: unknown } | undefined)?.$ref === PROBLEM_REF,
  );

/**
 * Every operation needs a bearer token (global security requirement) except the ones
 * marked @Access.public, which get `security: []`. Secured operations document 401 and 403;
 * every error response, those included, is application/problem+json with the
 * ProblemDetails schema, as ProblemDetailsFilter sends it.
 */
export function applySecurity(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.schemas ??= {};
  if (!document.components.schemas.ProblemDetails) {
    // Its .meta id makes Zod emit it under definitions.
    const generated = z.toJSONSchema(ProblemDetails, { target: 'openapi-3.0' }) as {
      definitions?: Record<string, unknown>;
    };
    document.components.schemas.ProblemDetails = (generated.definitions?.ProblemDetails ??
      generated) as never;
  }
  for (const item of Object.values(document.paths)) {
    for (const method of METHODS) {
      const operation = (item as Record<string, Operation | undefined>)[method];
      if (!operation) continue;
      operation.responses ??= {};
      const responses = operation.responses;
      if (operation[PUBLIC_EXTENSION]) {
        delete operation[PUBLIC_EXTENSION];
        operation.security = [];
      } else {
        responses['401'] ??= {
          description: 'Missing, invalid or expired bearer token (AUTH_TOKEN_*)',
        };
        responses['403'] ??= {
          description: 'Not allowed, or the login has no user yet (USER_NOT_REGISTERED)',
        };
      }
      for (const [status, response] of Object.entries(responses)) {
        if (Number(status) >= 400 && (!response.content || isProblem(response))) {
          response.content = structuredClone(PROBLEM_CONTENT);
        }
      }
    }
  }
  return document;
}

/**
 * CSP for the /docs page only: Scalar loads its bundle from jsDelivr and boots with an
 * inline script. Every other response keeps the strict default policy.
 */
const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');

/** OpenAPI 3 document generated from the controllers' Zod schemas, served at /openapi.json and /docs. */
export function setupOpenApi(app: NestFastifyApplication): void {
  const document = applySecurity(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Global Architecture Monolith API')
        .setDescription(
          'Public REST API. Every error is RFC 9457 application/problem+json with a stable `code`. ' +
            'Send an OIDC access token as `Authorization: Bearer <token>`; register once with ' +
            '`POST /v1/users`. Send x-request-id to correlate your logs with ours.',
        )
        .setVersion('1.0.0')
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
        .addSecurityRequirements('bearer')
        .build(),
    ),
  );
  app
    .getHttpAdapter()
    .getInstance()
    .get('/openapi.json', (_request, reply) => {
      void reply.send(document);
    });
  // The docs handler writes to the raw response, so Fastify onSend hooks do not run for it:
  // set the page's own CSP in a middleware mounted just before it.
  app.use(
    '/docs',
    (
      _request: unknown,
      response: { setHeader(name: string, value: string): void },
      next: () => void,
    ) => {
      response.setHeader('content-security-policy', DOCS_CSP);
      next();
    },
  );
  app.use('/docs', apiReference({ content: document, withFastify: true }));
}
