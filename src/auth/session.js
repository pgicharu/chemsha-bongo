// Login sessions, stored in Postgres. The session holds only userId; the user
// is re-read on each request so changes (e.g. confirmation) apply at once.

import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { pool, query } from '../db.js';
import { findUserById } from './users.js';

const PgStore = connectPgSimple(session);

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE_NAME = 'chemsha.sid';

// Shared with /api/logout so it clears the same cookie it set.
export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  // With an https APP_BASE_URL, logins over plain http will not stick.
  secure: config.baseUrl.startsWith('https://'),
  path: '/',
};

export const sessionMiddleware = session({
  name: SESSION_COOKIE_NAME,
  secret: config.sessionSecret,
  store: new PgStore({
    pool,
    tableName: 'session',
    // Created by migrations/001.
    createTableIfMissing: false,
    errorLog: (...args) => logger.error({ event: 'session.store_error', detail: args.map(String) }, 'Session store error'),
  }),
  resave: false,
  saveUninitialized: false,
  cookie: { ...sessionCookieOptions, maxAge: THIRTY_DAYS_MS },
});

// Sets req.user to the logged-in user or null.
export async function loadUser(req, res, next) {
  req.user = null;
  const userId = req.session?.userId;
  if (userId) {
    req.user = await findUserById(userId);
    // Account deleted while the session was alive.
    if (!req.user) delete req.session.userId;
  }
  next();
}

// Regenerates the session id first to prevent session fixation.
export async function logIn(req, userId) {
  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = userId;
  // Saved now so the session exists even if the rest of the request fails.
  await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

export async function logOut(req) {
  await new Promise((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));
}

// Ends all of the user's sessions except keepSessionId (used after a password reset).
export async function deleteUserSessions(userId, keepSessionId = '') {
  const { rowCount } = await query(`DELETE FROM session WHERE sess ->> 'userId' = $1 AND sid <> $2`, [
    String(userId),
    keepSessionId,
  ]);
  return rowCount;
}
