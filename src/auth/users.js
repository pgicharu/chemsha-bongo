// User account queries and the public user shape.

import { query } from '../db.js';

// `id` is a string (pg returns bigint as string). Never includes the password hash.
export function toPublicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatar: row.avatar,
    confirmed: row.confirmed_at !== null,
  };
}

const PUBLIC_COLUMNS = 'id, name, email, avatar, confirmed_at';

export async function findUserById(id) {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ? toPublicUser(rows[0]) : null;
}

// Includes password_hash. Case-insensitive, matching the unique index.
export async function findUserForLogin(email) {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`, [
    email,
  ]);
  return rows[0] ?? null;
}

// Returns the new user, or null if the email is already taken.
export async function createUser({ name, email, passwordHash, avatar }) {
  try {
    const { rows } = await query(
      `INSERT INTO users (name, email, password_hash, avatar)
       VALUES ($1, $2, $3, $4)
       RETURNING ${PUBLIC_COLUMNS}`,
      [name, email, passwordHash, avatar],
    );
    return toPublicUser(rows[0]);
  } catch (err) {
    // 23505 = unique_violation on users_email_unique.
    if (err.code === '23505') return null;
    throw err;
  }
}
