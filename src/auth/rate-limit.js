// Per-endpoint rate limits for sign-up, login, password reset and resend.
// The limit is generous because many players often share one public IP
// (same Wi-Fi). Counters are in memory: per process, reset on restart.

import { rateLimit } from 'express-rate-limit';
import { logger } from '../logger.js';

const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 50;

export function authRateLimit(name) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: LIMIT,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn({ event: 'auth.rate_limited', limiter: name }, `Rate limit reached: ${name}`);
      res.status(429).json({
        error: 'Too many attempts from this network. Please wait a few minutes and try again.',
        code: 'rate_limited',
      });
    },
  });
}
