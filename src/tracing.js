// OpenTelemetry tracing. Preloaded before the app with
// `node --import ./src/tracing.js src/server.js`, because auto-instrumentation
// can only patch libraries loaded after it is set up.
//
// Spans go over OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT; if nothing listens
// there they are dropped. Standard OTEL_* variables apply (OTEL_SERVICE_NAME,
// OTEL_SDK_DISABLED, OTEL_LOG_LEVEL). Metrics (prom-client) and logs (stdout)
// do not go through OpenTelemetry.

import { register } from 'node:module';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

// ESM loader hook so instrumentation can patch `import`ed libraries.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

// Polled every few seconds; not traced.
const UNTRACED_PATHS = ['/health', '/metrics'];

// Fault-injection control traffic is never traced. Read from env directly
// because this file runs before config.js.
const CHAOS_PORT = Number.parseInt(process.env.CHAOS_PORT || '9091', 10);

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME || 'chemsha-bongo',

  traceExporter: new OTLPTraceExporter(),

  metricReaders: [],
  logRecordProcessors: [],

  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (req) =>
          req.socket?.localPort === CHAOS_PORT || UNTRACED_PATHS.includes(new URL(req.url, 'http://x').pathname),
        // Email links carry one-time tokens and Socket.IO's sid identifies a
        // live connection; neither may appear in stored traces.
        redactedQueryParamsServer: ['token', 'sid'],
      },
      // Route handler spans only; per-middleware spans are noise.
      '@opentelemetry/instrumentation-express': { ignoreLayersType: ['middleware', 'router'] },
      // Express 5 uses `router`, which would duplicate the Express spans.
      '@opentelemetry/instrumentation-router': { enabled: false },
      // Receive spans are renamed after the event in game/sockets.js.
      '@opentelemetry/instrumentation-socket.io': {},
      // Adds trace_id/span_id to log lines; logs still go to stdout only.
      '@opentelemetry/instrumentation-pino': { disableLogSending: true },
      // Too noisy.
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
    }),
  ],
});

sdk.start();
