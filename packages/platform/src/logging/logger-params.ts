import type { Params } from 'nestjs-pino';

/** Fields that must never reach logs, wherever they appear. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
];

export interface LoggerConfig {
  readonly LOG_LEVEL: string;
  readonly LOG_PRETTY: boolean;
}

/**
 * nestjs-pino params: JSON to stdout, one line per request with its request id (Fastify
 * assigns request.id, see `requestIdFromHttp`; pino-http reuses it as `requestId`).
 * Health probes are not logged; 4xx answers are warnings, 5xx errors.
 */
export function loggerParams(appName: string, config: LoggerConfig): Params {
  return {
    pinoHttp: {
      level: config.LOG_LEVEL,
      base: { service: appName },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      customAttributeKeys: { reqId: 'requestId' },
      quietReqLogger: true,
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      ...(config.LOG_PRETTY
        ? {
            transport: {
              target: 'pino-pretty',
              options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' },
            },
          }
        : {}),
    },
  };
}
