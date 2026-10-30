import type { Http2ServerRequest } from 'node:http2';
import {
  type CallHandler,
  type ExecutionContext,
  GatewayTimeoutException,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';

/**
 * True once Fastify's per-request deadline (`handlerTimeout`, REQUEST_TIMEOUT_MS) fired for
 * this request: it aborts `request.signal` with FST_ERR_HANDLER_TIMEOUT and answers at once.
 */
export function isPastDeadline(request: FastifyRequest): boolean {
  const { signal } = request;
  return (
    signal.aborted &&
    (signal.reason as { code?: unknown } | undefined)?.code === 'FST_ERR_HANDLER_TIMEOUT'
  );
}

/** The HTTP/2 stream behind a request, or undefined on HTTP/1. */
export function http2StreamOf(request: FastifyRequest): Http2ServerRequest['stream'] | undefined {
  return request.raw.httpVersionMajor === 2
    ? (request.raw as unknown as Http2ServerRequest).stream
    : undefined;
}

/**
 * Stops a request whose deadline passed while guards ran (a slow identity lookup, say)
 * before its controller starts any work. The client already has its 504, and a write that
 * began after that answer would surprise a client that retries.
 */
@Injectable()
export class RequestDeadlineInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (isPastDeadline(context.switchToHttp().getRequest<FastifyRequest>())) {
      throw new GatewayTimeoutException();
    }
    return next.handle();
  }
}
