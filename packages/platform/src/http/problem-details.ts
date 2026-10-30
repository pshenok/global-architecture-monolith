import { STATUS_CODES } from 'node:http';
import { isDomainError, ValidationError } from '@gam/kernel';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { translateDbError } from '../database/pg-errors.ts';
import { KIND_TO_HTTP_STATUS } from './error-mapping.ts';
import { isPastDeadline } from './request-deadline.ts';

/** RFC 9457 problem details, plus machine-readable extensions shared by every error. */
export const ProblemDetails = z
  .object({
    type: z.string().describe('Always "about:blank"; use `code` to branch on errors.'),
    title: z.string().describe('HTTP reason phrase.'),
    status: z.number().int(),
    detail: z.string().optional().describe('Human-readable explanation (omitted for 5xx).'),
    instance: z.string().describe('Request path.'),
    code: z
      .string()
      .describe('Stable machine-readable reason, e.g. USER_EMAIL_TAKEN or NOT_FOUND.'),
    metadata: z.record(z.string(), z.string()).optional(),
    errors: z
      .array(z.object({ field: z.string(), description: z.string() }))
      .optional()
      .describe('Invalid fields (validation errors).'),
    requestId: z.string().describe('Correlation id, also in the x-request-id header.'),
  })
  .meta({ id: 'ProblemDetails' });

export type ProblemDetails = z.output<typeof ProblemDetails>;

function base(status: number, instance: string, requestId: string) {
  return {
    type: 'about:blank',
    title: STATUS_CODES[status] ?? 'Error',
    status,
    instance,
    requestId,
  };
}

/**
 * Maps any error to problem details:
 * - DomainError (a business rule, a validation, authentication): status by its kind,
 *   with its reason as `code`, its message as `detail` and its metadata
 * - a database error no repository translated: deadlocks and serialization failures
 *   become 409 TRANSACTION_CONFLICT, statement timeouts 503 DATABASE_TIMEOUT, wherever
 *   they happen (a read, SELECT ... FOR UPDATE, the commit)
 * - Nest HttpException (404 route, 429 throttling, ...)
 * - anything else: 500 without internals
 */
export function toProblemDetails(
  thrown: unknown,
  instance: string,
  requestId: string,
): ProblemDetails {
  const error = translateDbError(thrown);
  if (isDomainError(error)) {
    const status = KIND_TO_HTTP_STATUS[error.kind];
    return {
      ...base(status, instance, requestId),
      ...(status < 500 ? { detail: error.message } : {}),
      code: error.reason,
      ...(Object.keys(error.metadata).length > 0 ? { metadata: { ...error.metadata } } : {}),
      ...(error instanceof ValidationError && error.violations.length > 0
        ? { errors: [...error.violations] }
        : {}),
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return {
      ...base(status, instance, requestId),
      ...(status < 500 ? { detail: error.message } : {}),
      code: (STATUS_CODES[status] ?? 'ERROR').toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
    };
  }
  return { ...base(500, instance, requestId), code: 'INTERNAL' };
}

/**
 * The request's deadline (REQUEST_TIMEOUT_MS) passed. 504, not 503: the work may have
 * committed already, so the outcome is unknown and a blind retry is unsafe.
 */
export function requestTimeoutProblem(instance: string, requestId: string): ProblemDetails {
  return { ...base(504, instance, requestId), code: 'REQUEST_TIMEOUT' };
}

/** The app's only exception filter: every error leaves as application/problem+json. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    // An error that comes after the answer (work that outlived the deadline) has no one to
    // go to; the deadline was already logged.
    if (reply.sent) return;
    const instance = request.url.split('?')[0] ?? request.url;
    if (isPastDeadline(request)) {
      this.logger.warn(`request outlived REQUEST_TIMEOUT_MS: ${request.method} ${instance}`);
      void reply
        .status(504)
        .header('content-type', 'application/problem+json')
        .send(requestTimeoutProblem(instance, String(request.id)));
      return;
    }
    const problem = toProblemDetails(error, instance, String(request.id));
    if (problem.status >= 500) {
      this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    if (problem.status === 401) {
      // RFC 6750: say which scheme is expected, and whether the token sent was the problem.
      const presented = request.headers.authorization !== undefined;
      void reply.header(
        'www-authenticate',
        `Bearer realm="gam"${presented ? ', error="invalid_token"' : ''}`,
      );
    }
    void reply
      .status(problem.status)
      .header('content-type', 'application/problem+json')
      .send(problem);
  }
}
