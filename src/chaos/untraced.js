// Runs work with tracing suppressed; keeps fault-injection control queries out of traces.
// Mirrors @opentelemetry/core's suppressTracing() key (checked in test/chaos.test.js).

import { context, createContextKey } from '@opentelemetry/api';

export const SUPPRESS_TRACING_KEY = createContextKey('OpenTelemetry SDK Context Key SUPPRESS_TRACING');

export function untraced(work) {
  return context.with(context.active().setValue(SUPPRESS_TRACING_KEY, true), work);
}
