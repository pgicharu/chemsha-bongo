// JSON logging to stdout with pino.
// Convention: logger.info({ event: 'game.started', game_id: 12 }, 'Game started')
// with a dotted `event` name and snake_case IDs. trace_id/span_id are added by
// the OpenTelemetry pino instrumentation when tracing.js is preloaded.

import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  // Level as a label ("info") rather than a number.
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: 'chemsha-bongo' },
});

// Email links carry one-time tokens (?token=...); redact them before logging
// so anyone with log access cannot reuse them.
export function redactTokens(url) {
  return url.replace(/([?&]token=)[^&#]*/g, '$1REDACTED');
}
