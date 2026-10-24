// Accounts API (JSON). Errors are { error, code } plus `field` for validation errors.

import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { transaction } from '../db.js';
import { randomAvatar } from '../avatars.js';
import { sendEmail } from '../email/index.js';
import { confirmEmail, resetEmail } from '../email/templates.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.js';
import { createEmailToken, isTokenForConfirmedUser, useEmailToken } from './tokens.js';
import { createUser, findUserForLogin, toPublicUser } from './users.js';
import { SESSION_COOKIE_NAME, sessionCookieOptions, deleteUserSessions, logIn, logOut } from './session.js';
import { authRateLimit } from './rate-limit.js';
import { requireUser } from './guards.js';
import { avatarRouter } from './avatar.js';

export const authRouter = Router();
authRouter.use(avatarRouter);

// ---- Validation -------------------------------------------------------------

const PASSWORD_MIN = 8;
// Caps argon2 work on oversized input.
const PASSWORD_MAX = 200;

class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  // Counts code points, as Postgres does.
  const length = [...name].length;
  if (length < 1 || length > 60) throw new ValidationError('name', 'Please enter a name of 1 to 60 characters.');
  // Names end up in emails, so no control characters.
  if (/\p{Cc}/u.test(name)) throw new ValidationError('name', 'Your name can only contain normal characters.');
  return name;
}

function cleanEmail(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  // Deliberately loose; the confirmation email is the real check.
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError('email', 'Please enter a valid email address.');
  }
  return email;
}

function cleanPassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (password.length < PASSWORD_MIN) {
    throw new ValidationError('password', `Your password needs at least ${PASSWORD_MIN} characters.`);
  }
  if (password.length > PASSWORD_MAX) {
    throw new ValidationError('password', `Your password can be at most ${PASSWORD_MAX} characters.`);
  }
  return password;
}

function validate(res, checks) {
  try {
    return checks();
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    res.status(400).json({ error: err.message, code: 'invalid', field: err.field });
    return null;
  }
}

// ---- Emails -----------------------------------------------------------------

// Throws if the email could not be sent.
async function sendConfirmationEmail(user) {
  const token = await createEmailToken(user.id, 'confirm');
  const link = `${config.baseUrl}/confirm?token=${token}`;
  await sendEmail({ to: user.email, ...confirmEmail({ name: user.name, link }) });
}

// Does not throw on a failed send: sendEmail() logs it and the response is already sent.
async function sendResetEmail(email) {
  const row = await findUserForLogin(email);
  logger.info(
    { event: 'auth.password_reset_requested', account_found: Boolean(row), player_id: row?.id },
    'Password reset requested',
  );
  if (!row) return;

  const token = await createEmailToken(row.id, 'reset');
  const link = `${config.baseUrl}/reset?token=${token}`;
  try {
    await sendEmail({ to: row.email, ...resetEmail({ name: row.name, link }) });
  } catch {
    // Already logged by sendEmail() as email.failed.
  }
}

// ---- Sign-up ----------------------------------------------------------------

authRouter.post('/api/signup', authRateLimit('signup'), async (req, res) => {
  const input = validate(res, () => ({
    name: cleanName(req.body?.name),
    email: cleanEmail(req.body?.email),
    password: cleanPassword(req.body?.password),
  }));
  if (!input) return;

  const user = await createUser({
    name: input.name,
    email: input.email,
    passwordHash: await hashPassword(input.password),
    avatar: randomAvatar(),
  });
  if (!user) {
    return res.status(409).json({
      error: 'There is already an account with this email. Try logging in instead.',
      code: 'email_taken',
      field: 'email',
    });
  }

  await logIn(req, user.id);
  logger.info({ event: 'auth.signup', player_id: user.id }, 'New account created');

  // Waits for the send, so SMTP latency shows in the sign-up request and span.
  // A failed send still leaves the account created and logged in.
  let emailSent = true;
  try {
    await sendConfirmationEmail(user);
  } catch {
    // Already logged by sendEmail() as email.failed.
    emailSent = false;
  }

  res.status(201).json({ user, emailSent });
});

// ---- Email confirmation -----------------------------------------------------

// The token alone identifies the account. Not rate limited: 32 random bytes are unguessable.
authRouter.post('/api/confirm', async (req, res) => {
  const token = req.body?.token;

  const userId = await transaction(async (client) => {
    const id = await useEmailToken(client, token, 'confirm');
    if (id) {
      await client.query('UPDATE users SET confirmed_at = coalesce(confirmed_at, now()) WHERE id = $1', [id]);
    }
    return id;
  });

  if (userId) {
    logger.info({ event: 'auth.confirmed', player_id: userId }, 'Email confirmed');
    return res.json({ confirmed: true });
  }
  if (await isTokenForConfirmedUser(token)) {
    return res.json({ confirmed: true, alreadyConfirmed: true });
  }
  res.status(400).json({
    error: 'This confirmation link is invalid or has expired. Log in and ask for a new one.',
    code: 'invalid_token',
  });
});

authRouter.post('/api/confirm/resend', authRateLimit('confirm_resend'), requireUser, async (req, res) => {
  if (req.user.confirmed) {
    return res.json({ sent: false, alreadyConfirmed: true });
  }
  try {
    await sendConfirmationEmail(req.user);
  } catch {
    return res.status(503).json({
      error: "We couldn't send the email just now. Please try again in a few minutes.",
      code: 'email_failed',
    });
  }
  logger.info({ event: 'auth.confirm_resent', player_id: req.user.id }, 'Confirmation email sent again');
  res.json({ sent: true });
});

// ---- Login and logout -------------------------------------------------------

authRouter.post('/api/login', authRateLimit('login'), async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  const row = email && password.length <= PASSWORD_MAX ? await findUserForLogin(email) : null;
  // Always run a password check, even without an account, for uniform timing.
  const ok = row ? await verifyPassword(row.password_hash, password) : await verifyAgainstDummy(password);

  if (!ok) {
    // Same response either way so accounts cannot be enumerated; `reason` is logs only.
    logger.info(
      { event: 'auth.login_failed', reason: row ? 'wrong_password' : 'no_account', player_id: row?.id },
      'Login failed',
    );
    return res.status(401).json({ error: 'That email and password don’t match an account.', code: 'bad_credentials' });
  }

  await logIn(req, row.id);
  logger.info({ event: 'auth.login', player_id: row.id }, 'Logged in');
  res.json({ user: toPublicUser(row) });
});

authRouter.post('/api/logout', async (req, res) => {
  const playerId = req.user?.id;
  if (req.session) await logOut(req);
  res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions);
  if (playerId) logger.info({ event: 'auth.logout', player_id: playerId }, 'Logged out');
  res.json({ ok: true });
});

// Always 200; user is null when logged out.
authRouter.get('/api/me', (req, res) => {
  res.json({ user: req.user });
});

// ---- Forgotten password -----------------------------------------------------

const FORGOT_MESSAGE = 'If there is an account with that email, we have sent it a link to reset the password.';

authRouter.post('/api/password/forgot', authRateLimit('password_forgot'), async (req, res) => {
  const email = validate(res, () => cleanEmail(req.body?.email));
  if (email === null) return;

  // Uniform answer, sent before the email so timing does not reveal whether the account exists.
  res.json({ message: FORGOT_MESSAGE });

  try {
    await sendResetEmail(email);
  } catch (err) {
    logger.error({ event: 'auth.password_reset_failed', err }, 'Could not create a password reset link');
  }
});

authRouter.post('/api/password/reset', authRateLimit('password_reset'), async (req, res) => {
  const password = validate(res, () => cleanPassword(req.body?.password));
  if (password === null) return;
  const passwordHash = await hashPassword(password);

  const userId = await transaction(async (client) => {
    const id = await useEmailToken(client, req.body?.token, 'reset');
    if (id) {
      // A reset link proves ownership of the address, so it also confirms it.
      await client.query(
        `UPDATE users SET password_hash = $2, confirmed_at = coalesce(confirmed_at, now()) WHERE id = $1`,
        [id, passwordHash],
      );
    }
    return id;
  });

  if (!userId) {
    return res.status(400).json({
      error: 'This reset link is invalid, expired or already used. Ask for a new one.',
      code: 'invalid_token',
    });
  }

  // End all other sessions for this account.
  const ended = await deleteUserSessions(userId, req.sessionID);
  logger.info({ event: 'auth.password_reset', player_id: userId, sessions_ended: ended }, 'Password changed');
  res.json({ ok: true });
});
