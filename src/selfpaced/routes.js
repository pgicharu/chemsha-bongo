// HTTP API for self-paced quizzes (used by web/take.html and src/bots/).
//
//   POST /api/play/:slug/start     → { attemptId, quizTitle, totalQuestions, dueAt, answered }
//   POST /api/play/:slug/question  → { questionNo, total, prompt, options, timeLimitSeconds, remainingMs }
//                                    or { finished: true, score, correctCount, total }
//   POST /api/play/:slug/answer    { questionNo, option } → { result, points, totalScore, correctOption }
//   GET  /api/play/:slug/result    → { finished, score, correctCount, total, completedAt }
//
// Errors are { error, code }; `error` is safe to show. /question is POST
// because it can start a question's clock and must never be cached or prefetched.

import { Router } from 'express';
import { requireUser, requireConfirmed } from '../auth/index.js';
import { SelfPacedError, oneAtATime, findSelfPacedQuiz, startAttempt, currentQuestion, submitAnswer, getResult } from './attempts.js';

export const selfPacedRouter = Router();

// Malformed slugs get the same 404 as unknown ones.
function validSlug(slug) {
  return /^[a-z0-9]{1,32}$/.test(slug);
}

// Runs `work` serialised per player; other errors fall through to Express (500).
function playRoute(work) {
  return async (req, res) => {
    // Answers are judged by this time, so read it before queueing.
    const receivedAtMs = Date.now();
    try {
      if (!validSlug(req.params.slug)) throw new SelfPacedError(404, 'not_found', 'Quiz not found');
      const quiz = await findSelfPacedQuiz(req.params.slug);
      const body = await oneAtATime(`${quiz.id}:${req.user.id}`, () => work(req, quiz, receivedAtMs));
      res.json(body);
    } catch (err) {
      if (!(err instanceof SelfPacedError)) throw err;
      res.status(err.status).json({ error: err.message, code: err.code });
    }
  };
}

selfPacedRouter.post(
  '/api/play/:slug/start',
  requireConfirmed,
  // Non-answer routes read the clock when their turn comes, so queueing time
  // is not handed back as extra time.
  playRoute((req, quiz) => startAttempt(quiz, req.user, Date.now())),
);

selfPacedRouter.post(
  '/api/play/:slug/question',
  requireConfirmed,
  playRoute((req, quiz) => currentQuestion(quiz, req.user, Date.now())),
);

selfPacedRouter.post(
  '/api/play/:slug/answer',
  requireConfirmed,
  playRoute((req, quiz, receivedAtMs) =>
    submitAnswer(quiz, req.user, { questionNo: req.body?.questionNo, option: req.body?.option }, receivedAtMs),
  ),
);

selfPacedRouter.get(
  '/api/play/:slug/result',
  requireUser,
  playRoute((req, quiz) => getResult(quiz, req.user, Date.now())),
);
