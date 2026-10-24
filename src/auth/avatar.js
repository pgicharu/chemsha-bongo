// Avatar API: GET /api/avatar/options and PUT /api/me/avatar. Avatars are
// stored as options, not images (see src/avatars.js). Sockets read the user on
// connect, so a change shows in games from the next join.

import { Router } from 'express';
import { logger } from '../logger.js';
import { query } from '../db.js';
import { AVATAR_OPTIONS, AvatarError, validateAvatar } from '../avatars.js';
import { toPublicUser } from './users.js';
import { requireUser } from './guards.js';

export const avatarRouter = Router();

// Static after startup and the same for everyone, so cacheable.
avatarRouter.get('/api/avatar/options', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(AVATAR_OPTIONS);
});

avatarRouter.put('/api/me/avatar', requireUser, async (req, res) => {
  let avatar;
  try {
    avatar = validateAvatar(req.body?.avatar);
  } catch (err) {
    if (!(err instanceof AvatarError)) throw err;
    return res.status(400).json({ error: err.message, code: 'invalid', field: 'avatar' });
  }

  const { rows } = await query(
    `UPDATE users SET avatar = $2 WHERE id = $1
     RETURNING id, name, email, avatar, confirmed_at`,
    [req.user.id, avatar],
  );
  logger.info({ event: 'avatar.updated', player_id: req.user.id, style: avatar.style }, 'Avatar updated');
  res.json({ user: toPublicUser(rows[0]) });
});
