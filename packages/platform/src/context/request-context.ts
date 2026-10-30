import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { ClsServiceManager } from 'nestjs-cls';

/** Correlation header: read from the client when safe, returned on every response, logged on every line. */
export const REQUEST_ID_KEY = 'x-request-id';

const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/;

/** Returns the value when it is a safe request id, otherwise undefined (ids are client-controlled). */
export function sanitizeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_REQUEST_ID.test(value) ? value : undefined;
}

/**
 * Fastify `genReqId`: reuse a safe inbound `x-request-id`, otherwise generate one.
 * The same id then flows into logs, the request context (CLS) and the events a request
 * records.
 */
export function requestIdFromHttp(request: { headers: IncomingHttpHeaders }): string {
  const header = request.headers[REQUEST_ID_KEY];
  return sanitizeRequestId(Array.isArray(header) ? header[0] : header) ?? randomUUID();
}

/** Request id of the current request, or undefined outside of one. */
export function currentRequestId(): string | undefined {
  try {
    const cls = ClsServiceManager.getClsService();
    return cls.isActive() ? cls.getId() : undefined;
  } catch {
    return undefined;
  }
}
