// Prometheus metrics: every metric the app exposes is defined here.
//
// Label values must come from a small fixed set. Never use player names,
// emails, ids or game codes as labels; each distinct value is a new series.

import { Router } from 'express';
import client from 'prom-client';

export const registry = client.register;

client.collectDefaultMetrics({ register: registry });

// These gauges are computed from engine state at scrape time (collect()), so
// they cannot drift. The engine registers the reader, which avoids importing
// the engine (and the database) here.
let readGameState = () => ({ gamesActive: 0, playersConnected: 0 });

export function setGameStateReader(reader) {
  readGameState = reader;
}

// Counts sockets, not people: two tabs count twice.
export const playersConnected = new client.Gauge({
  name: 'chemsha_players_connected',
  help: 'Open player sockets in games that are in the lobby or running (host screens not counted)',
  collect() {
    this.set(readGameState().playersConnected);
  },
});

export const gamesActive = new client.Gauge({
  name: 'chemsha_games_active',
  help: 'Games in memory that are in the lobby or running',
  collect() {
    this.set(readGameState().gamesActive);
  },
});

// 'late' = after deadline + grace. Rows for players who did not answer are not counted.
export const answersTotal = new client.Counter({
  name: 'chemsha_answers_total',
  help: 'Answers received from players, by result (correct, wrong, late)',
  labelNames: ['result'],
});
// Initialise every series at 0 so graphs and alerts show 0, not "no data".
for (const result of ['correct', 'wrong', 'late']) {
  answersTotal.labels(result).inc(0);
}

// Measured in processAnswer (engine.js). Buckets reach 10 s so slow-database
// saves land in a real bucket rather than only +Inf.
export const answerScoringSeconds = new client.Histogram({
  name: 'chemsha_answer_scoring_seconds',
  help: 'Time from an answer being received to its score being saved',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// Socket.IO's disconnect reason is a small fixed set, so it is a safe label.
export const socketDisconnectsTotal = new client.Counter({
  name: 'chemsha_socket_disconnects_total',
  help: 'Socket.IO disconnects, by Socket.IO disconnect reason',
  labelNames: ['reason'],
});

// `route` is the Express route pattern (see routeLabel). Socket.IO traffic is not counted.
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration, by method, route pattern and status code',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// Counted in sendEmail() (email/index.js). result=logged means EMAIL_TRANSPORT=log.
export const emailsSentTotal = new client.Counter({
  name: 'chemsha_emails_sent_total',
  help: 'Emails, by template and result (sent, failed, logged)',
  labelNames: ['template', 'result'],
});

// `route` label: the route pattern, never the raw URL (ids would explode
// cardinality). req.baseUrl is the matched URL, not a pattern, so never mount
// a router at a parameterised path. Static files are "static"; everything
// else (404s, early rejections) is "unmatched".
export function routeLabel(req, res) {
  if (req.route) return `${req.baseUrl ?? ''}${req.route.path}`;
  if (res.locals?.servedStatic) return 'static';
  return 'unmatched';
}

// Mount first so the timing covers all other middleware.
export function httpMetricsMiddleware(req, res, next) {
  const stopTimer = httpRequestDuration.startTimer();
  res.on('finish', () => {
    stopTimer({ method: req.method, route: routeLabel(req, res), status: res.statusCode });
  });
  next();
}

// Placed before express.static; the 404 handler clears the flag if no file matched.
export function markStatic(req, res, next) {
  res.locals.servedStatic = true;
  next();
}

// Public by design so Prometheus can scrape without auth; restrict it in
// deploy/Caddyfile if needed.
export const metricsRouter = Router();

metricsRouter.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
});
