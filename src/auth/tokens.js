// One-time email tokens (confirm, reset). Only the SHA-256 hash is stored, so
// a database leak does not yield working links.

import { createHash, randomBytes } from 'node:crypto';
import { query } from '../db.js';

const LIFETIME = {
  confirm: '48 hours',
  reset: '1 hour',
};

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// Rejects obviously invalid input before querying (real tokens are 43 chars).
function looksLikeToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= 100;
}

// Returns the raw token. A new reset token invalidates older unused ones.
export async function createEmailToken(userId, purpose) {
  if (purpose === 'reset') {
    await query(
      `UPDATE email_tokens SET used_at = now()
       WHERE user_id = $1 AND purpose = 'reset' AND used_at IS NULL`,
      [userId],
    );
  }

  const token = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at)
     VALUES ($1, $2, $3, now() + $4::interval)`,
    [hashToken(token), userId, purpose, LIFETIME[purpose]],
  );
  return token;
}

// Marks a valid token used and returns its user id, or null. `db` may be a
// transaction client.
export async function useEmailToken(db, token, purpose) {
  if (!looksLikeToken(token)) return null;

  // Check and mark in one statement so concurrent uses cannot both succeed.
  const { rows } = await db.query(
    `UPDATE email_tokens SET used_at = now()
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [hashToken(token), purpose],
  );
  return rows[0]?.user_id ?? null;
}

// For a refused token: true if it was a confirm link for an already-confirmed account.
export async function isTokenForConfirmedUser(token) {
  if (!looksLikeToken(token)) return false;
  const { rows } = await query(
    `SELECT 1 FROM email_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.purpose = 'confirm' AND u.confirmed_at IS NOT NULL`,
    [hashToken(token)],
  );
  return rows.length > 0;
}
