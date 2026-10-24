// Bot login sessions, written straight to the database. Never do this for real
// users. Bots bypass POST /api/login because 50 logins from one address would
// trip the login rate limit and bot passwords are unknown.
//
// The session row matches connect-pg-simple's and the cookie is signed the
// way express-session/cookie-signature do it, so the app cannot tell a bot
// session from a browser one. test/bots.test.js checks express-session accepts it.

import { createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';

export const SESSION_COOKIE_NAME = 'chemsha.sid';

// Tools delete their sessions on exit; the expiry only matters if one is killed.
const BOT_SESSION_MS = 12 * 60 * 60 * 1000;

// Same output as cookie-signature's sign().
function signValue(value, secret) {
  const signature = createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '');
  return `${value}.${signature}`;
}

export function sessionCookieHeader(sid, secret = config.sessionSecret) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(`s:${signValue(sid, secret)}`)}`;
}

// Same shape express-session stores for a logged-in browser.
export function sessionData(userId, now = Date.now()) {
  return {
    cookie: {
      originalMaxAge: BOT_SESSION_MS,
      expires: new Date(now + BOT_SESSION_MS).toISOString(),
      secure: config.baseUrl.startsWith('https://'),
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
    },
    userId: String(userId),
  };
}

export async function createBotSession(userId) {
  const sid = randomBytes(24).toString('base64url');
  const sess = sessionData(userId);
  // Same statement connect-pg-simple uses.
  await query('INSERT INTO session (sid, sess, expire) VALUES ($1, $2, to_timestamp($3))', [
    sid,
    sess,
    Math.ceil(new Date(sess.cookie.expires).getTime() / 1000),
  ]);
  return { sid, cookie: sessionCookieHeader(sid) };
}

export async function deleteBotSessions(sids) {
  if (sids.length === 0) return;
  await query('DELETE FROM session WHERE sid = ANY($1::text[])', [sids]);
}
