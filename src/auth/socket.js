// Socket.IO auth: runs the session middleware on the handshake request and
// sets socket.data.user to the same shape as req.user.

import { logger } from '../logger.js';
import { sessionMiddleware } from './session.js';
import { findUserById } from './users.js';

export function attachSocketAuth(io) {
  // Only the handshake (no `sid` query param) needs the session; skipping the
  // rest avoids a lookup on every long-polling request.
  io.engine.use((req, res, next) => {
    const isHandshake = req._query.sid === undefined;
    if (isHandshake) {
      sessionMiddleware(req, res, next);
    } else {
      next();
    }
  });

  // Rejection surfaces on the client as connect_error 'unauthenticated'.
  io.use(async (socket, next) => {
    try {
      const userId = socket.request.session?.userId;
      const user = userId ? await findUserById(userId) : null;
      if (!user) {
        return next(new Error('unauthenticated'));
      }
      socket.data.user = user;
      next();
    } catch (err) {
      logger.error({ event: 'socket.auth_failed', err }, 'Could not check a socket login');
      next(new Error('server_error'));
    }
  });
}
