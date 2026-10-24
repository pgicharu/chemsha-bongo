// HTTP routes for live games: create a game and follow a join link. Gameplay
// itself runs over Socket.IO (sockets.js).

import { Router } from 'express';
import { query } from '../db.js';
import { config } from '../config.js';
import { requireUser, requireConfirmed } from '../auth/index.js';
import { createGame } from './engine.js';

export const gameRouter = Router();

// POST /api/games  { quizId }  →  201 { gameId, code, joinUrl }
gameRouter.post('/api/games', requireUser, requireConfirmed, async (req, res) => {
  const quizId = Number(req.body?.quizId);
  if (!Number.isSafeInteger(quizId) || quizId <= 0) {
    return res.status(400).json({ error: 'quizId must be a quiz id', code: 'bad_request' });
  }

  const { rows: quizzes } = await query('SELECT id, owner_id, title, mode FROM quizzes WHERE id = $1', [quizId]);
  const quiz = quizzes[0];
  if (!quiz) {
    return res.status(404).json({ error: 'Quiz not found', code: 'not_found' });
  }
  // pg returns bigint ids as strings.
  if (String(quiz.owner_id) !== String(req.user.id)) {
    return res.status(403).json({ error: 'Only the owner of this quiz can host it', code: 'not_owner' });
  }
  if (quiz.mode !== 'live') {
    return res.status(400).json({ error: 'This quiz is self-paced. Switch it to live to host a game.', code: 'not_live' });
  }

  const { rows: questions } = await query(
    `SELECT id, prompt, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds
     FROM questions WHERE quiz_id = $1 ORDER BY position`,
    [quizId],
  );
  if (questions.length === 0) {
    return res.status(400).json({ error: 'Add at least one question before hosting this quiz.', code: 'no_questions' });
  }

  const game = await createGame({ quiz, questions, hostId: req.user.id });
  res.status(201).json({ gameId: game.id, code: game.code, joinUrl: `${config.baseUrl}/join/${game.code}` });
});

// GET /join/123456  →  /play?code=123456 (short link shown on the projector)
gameRouter.get('/join/:code', (req, res) => {
  const code = String(req.params.code).replace(/\D/g, '').slice(0, 6);
  res.redirect(`/play?code=${code}`);
});
