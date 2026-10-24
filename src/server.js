// Entry point: migrations, Express app, Socket.IO, graceful shutdown.
// tracing.js is not imported here; it is preloaded with
// `node --import ./src/tracing.js src/server.js`.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { Server as SocketServer } from 'socket.io';

import { config } from './config.js';
import { logger, redactTokens } from './logger.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { healthRouter } from './health.js';
import { metricsRouter, httpMetricsMiddleware, markStatic, socketDisconnectsTotal } from './metrics.js';
import { sessionMiddleware, loadUser, authRouter, attachSocketAuth } from './auth/index.js';
import { quizzesRouter } from './quizzes/index.js';
import { gameRouter, registerGameSockets, markInterruptedGamesAbandoned } from './game/index.js';
import { selfPacedRouter } from './selfpaced/index.js';
import { botsRouter } from './bots/routes.js';
import { startChaosControl } from './chaos/control.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.resolve(rootDir, config.webDir);

// Polled every few seconds; not logged, but still counted in metrics.
const UNLOGGED_PATHS = ['/health', '/metrics'];

function buildApp() {
  const app = express();

  // One proxy hop (Caddy or ngrok); rate limits rely on the real req.ip.
  app.set('trust proxy', 1);

  // First, so the measured time covers every middleware below.
  app.use(httpMetricsMiddleware);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Avatars are inline SVG data: URIs.
          'img-src': ["'self'", 'data:'],
          // Off so the app also works over plain http on a LAN IP.
          'upgrade-insecure-requests': null,
        },
      },
    }),
  );

  app.use(
    pinoHttp({
      logger,
      // Set event only on the completion line so handler logs keep their own.
      customSuccessObject: (req, res, value) => ({ ...value, event: 'http.request' }),
      customErrorObject: (req, res, err, value) => ({ ...value, event: 'http.request' }),
      autoLogging: { ignore: (req) => UNLOGGED_PATHS.includes(req.path) },
      // No headers (session cookies) and no one-time tokens in logged URLs.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: redactTokens(req.url) }),
        res: (res) => ({ status_code: res.statusCode }),
      },
    }),
  );

  app.use(express.json());
  app.use(healthRouter);
  // Before the session middleware: scrapes need no session.
  app.use(metricsRouter);

  app.use(sessionMiddleware);
  app.use(loadUser);

  app.use(authRouter);
  app.use(quizzesRouter);
  app.use(gameRouter);
  app.use(botsRouter); // only active when ALLOW_BOTS=true
  app.use(selfPacedRouter);

  // `extensions` lets /login serve login.html.
  app.use(markStatic, express.static(webDir, { extensions: ['html'] }));

  app.use((req, res) => {
    res.locals.servedStatic = false; // see metrics.js
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Client errors (e.g. bad JSON 400, body too large 413) keep their status
    // so they don't count as 500s.
    if (err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: 'That request could not be understood.', code: 'bad_request' });
    }
    // Details go to the logs only; the client gets a generic message.
    req.log.error({ event: 'http.error', err }, 'Unhandled error in request');
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

function attachSockets(httpServer) {
  const io = new SocketServer(httpServer);

  // Rejects anonymous sockets and sets socket.data.user.
  attachSocketAuth(io);

  io.on('connection', (socket) => {
    logger.info({ event: 'socket.connected', socket_id: socket.id, player_id: socket.data.user?.id }, 'Socket connected');
    socket.on('disconnect', (reason) => {
      socketDisconnectsTotal.labels(reason).inc();
      logger.info(
        { event: 'socket.disconnected', socket_id: socket.id, player_id: socket.data.user?.id, reason },
        'Socket disconnected',
      );
    });
  });

  registerGameSockets(io);
  return io;
}

// State is unknown after an uncaught exception: log and exit, and let Docker
// restart the process. pino writes stdout synchronously, so the line is flushed.
process.on('uncaughtException', (err, origin) => {
  logger.fatal({ event: 'process.crashed', origin, err }, `Crashed: ${err.message}`);
  process.exit(1);
});

async function main() {
  await migrate();
  await markInterruptedGamesAbandoned();
  await startChaosControl();

  const app = buildApp();
  const httpServer = http.createServer(app);
  const io = attachSockets(httpServer);

  httpServer.listen(config.port, () => {
    logger.info({ event: 'server.started', port: config.port }, `Chemsha Bongo listening on port ${config.port}`);
  });

  let stopping = false;
  const shutdown = (signal) => {
    // A second signal exits immediately.
    if (stopping) process.exit(1);
    stopping = true;
    logger.info({ event: 'server.stopping', signal }, 'Shutting down');
    // io.close() disconnects sockets and closes the HTTP server, letting
    // in-flight requests finish; then the pool is closed.
    io.close(async () => {
      await pool.end();
      process.exit(0);
    });
    // Hard deadline in case something hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ event: 'server.start_failed', err }, 'Failed to start');
  process.exit(1);
});
