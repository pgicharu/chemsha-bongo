// Bot accounts: real users rows with is_bot = true (at most 50 players and one
// host), created on first use. Emails use the reserved .invalid TLD, accounts
// are pre-confirmed, and passwords are random and discarded, so nobody can log
// in as a bot (sessions come from sessions.js). is_bot keeps them out of
// results, CSV exports and attempt counts.

import { randomBytes } from 'node:crypto';
import { query } from '../db.js';
import { randomAvatar } from '../avatars.js';
import { hashPassword } from '../auth/passwords.js';
import { pickBotName } from './names.js';

export const MAX_BOTS = 50;

const EMAIL_DOMAIN = 'bots.chemsha.invalid';
const HOST_EMAIL = `bot-host@${EMAIL_DOMAIN}`;
const HOST_NAME = 'Quiz Bot';

function botEmail(n) {
  return `bot-${String(n).padStart(3, '0')}@${EMAIL_DOMAIN}`;
}

async function unusablePasswordHash() {
  return hashPassword(randomBytes(32).toString('hex'));
}

// ON CONFLICT: another bot tool may be creating the same accounts concurrently.
async function insertBot(name, email) {
  await query(
    `INSERT INTO users (name, email, password_hash, avatar, is_bot, confirmed_at)
     VALUES ($1, $2, $3, $4, true, now())
     ON CONFLICT (lower(email)) DO NOTHING`,
    [name, email, await unusablePasswordHash(), randomAvatar()],
  );
}

async function loadBotPlayers() {
  const { rows } = await query(
    `SELECT id, name, email FROM users
      WHERE is_bot AND email LIKE 'bot-___@${EMAIL_DOMAIN}'
      ORDER BY email`,
  );
  return rows;
}

// The first call takes a few seconds (password hashing); later calls are one query.
export async function ensureBotPlayers() {
  let bots = await loadBotPlayers();
  if (bots.length >= MAX_BOTS) return bots;

  const existingEmails = new Set(bots.map((b) => b.email));
  const takenNames = new Set(bots.map((b) => b.name));
  for (let n = 1; n <= MAX_BOTS; n += 1) {
    if (existingEmails.has(botEmail(n))) continue;
    const name = pickBotName(takenNames);
    takenNames.add(name);
    await insertBot(name, botEmail(n));
  }
  bots = await loadBotPlayers();
  return bots;
}

export async function ensureBotHost() {
  const find = () => query('SELECT id, name, email FROM users WHERE lower(email) = $1', [HOST_EMAIL]);
  let { rows } = await find();
  if (rows.length === 0) {
    await insertBot(HOST_NAME, HOST_EMAIL);
    ({ rows } = await find());
  }
  return rows[0];
}

// Fisher-Yates on a copy.
export function shuffled(list, random = Math.random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
