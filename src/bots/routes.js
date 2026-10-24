// Lobby "Add bots" endpoints (web/js/game/host.js). Bots run in-process and
// connect back over loopback. With ALLOW_BOTS=false the routes answer 404 as
// if they did not exist; keep it off on shared servers.
//
//   GET  /api/bots                       → { enabled }
//   POST /api/games/:id/bots  { count }  → 202 { added, players }   owner only

import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { requireConfirmed } from '../auth/index.js';
import { getGame, MAX_PLAYERS } from '../game/engine.js';
import { joinLiveGame } from './live-player.js';

export const botsRouter = Router();

// Serialised per game so two quick clicks cannot pick the same bots
// (game.players is up to date once joinLiveGame resolves).
const lastRequest = new Map(); // gameId -> promise of the latest request

function oneAtATime(gameId, work) {
  const previous = lastRequest.get(gameId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  lastRequest.set(gameId, current);
  current
    .finally(() => {
      if (lastRequest.get(gameId) === current) lastRequest.delete(gameId);
    })
    .catch(() => {});
  return current;
}

// Only problems are logged for in-process bots.
const botLog = {
  info() {},
  warn: (message) => logger.warn({ event: 'bots.problem' }, message),
};

botsRouter.get('/api/bots', (req, res) => {
  res.json({ enabled: config.bots.allowed });
});

// Runs before the login check so a disabled feature looks like a missing route.
function botsAllowed(req, res, next) {
  if (config.bots.allowed) return next();
  res.status(404).json({ error: 'Not found' });
}

function notInLobby(res) {
  return res.status(409).json({ error: 'Bots can only join while the game is in the lobby.', code: 'not_lobby' });
}

botsRouter.post('/api/games/:id/bots', botsAllowed, requireConfirmed, async (req, res) => {
  const game = getGame(req.params.id);
  if (!game || game.hostId !== String(req.user.id)) {
    return res.status(404).json({ error: 'Game not found', code: 'not_found' });
  }
  if (game.phase !== 'lobby') return notInLobby(res);

  const added = await oneAtATime(game.id, async () => {
    // Re-checked: the game may have started or filled while queued.
    if (game.phase !== 'lobby') return 0;
    const wanted = Math.min(Math.max(Number.parseInt(req.body?.count, 10) || 5, 1), MAX_PLAYERS);
    const count = Math.min(wanted, MAX_PLAYERS - game.players.size);
    if (count <= 0) return 0;
    const group = await joinLiveGame({
      baseUrl: `http://127.0.0.1:${config.port}`,
      code: game.code,
      count,
      excludeUserIds: new Set(game.players.keys()),
      log: botLog,
    });
    return group.bots.length;
  });
  if (added === 0) {
    if (game.phase !== 'lobby') return notInLobby(res);
    return res.status(409).json({ error: `The game is full (${MAX_PLAYERS} players).`, code: 'full' });
  }

  logger.info({ event: 'bots.added', game_id: game.id, count: added }, `${added} bots sent into the game`);
  res.status(202).json({ added, players: game.players.size });
});
