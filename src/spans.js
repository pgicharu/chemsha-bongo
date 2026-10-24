// inSpan(): manual spans for app work, alongside auto-instrumentation.
// No-op when tracing is not set up (e.g. unit tests). `options` are passed to
// OpenTelemetry, e.g. { kind: SpanKind.CLIENT } or { root: true } to start a
// new trace (used for timer-driven work).

import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('chemsha-bongo');

// Errors are recorded on the span and rethrown.
export function inSpan(name, attributes, work, options = {}) {
  return tracer.startActiveSpan(name, { ...options, attributes }, async (span) => {
    try {
      return await work(span);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}
