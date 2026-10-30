/**
 * OpenTelemetry bootstrap. Load it BEFORE the app:
 *
 *   node --import @gam/platform/telemetry dist/main.js
 *
 * It is a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT (or ..._TRACES_ENDPOINT) is
 * set, so it costs nothing by default. Traces cover inbound and outbound HTTP, pg
 * queries and Fastify routes, and pino lines get trace_id/span_id. The service name
 * comes from OTEL_SERVICE_NAME.
 */
const endpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;

if (endpoint && process.env.OTEL_SDK_DISABLED !== 'true') {
  // Synchronous in-thread ESM hooks (module.registerHooks): must run before the app graph loads.
  const { register } = await import('import-in-the-middle/register-hooks.mjs');
  register();

  const [{ NodeSDK }, { HttpInstrumentation }, { PgInstrumentation }, { PinoInstrumentation }] =
    await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/instrumentation-http'),
      import('@opentelemetry/instrumentation-pg'),
      import('@opentelemetry/instrumentation-pino'),
    ]);

  const instrumentations: unknown[] = [
    new HttpInstrumentation(),
    new PgInstrumentation(),
    new PinoInstrumentation(),
  ];

  // Fastify route spans; the platform depends on @fastify/otel, so resolve it from here.
  const { FastifyOtelInstrumentation } = await import('@fastify/otel');
  instrumentations.push(new FastifyOtelInstrumentation({ registerOnInitialization: true }));

  type SdkInstrumentations = NonNullable<
    NonNullable<ConstructorParameters<typeof NodeSDK>[0]>['instrumentations']
  >;
  const sdk = new NodeSDK({ instrumentations: instrumentations as SdkInstrumentations });
  sdk.start();

  const shutdown = (): void => {
    sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
