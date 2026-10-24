// Quizzes: create, edit, share, results and CSV export.
// Non-owners get 404, not 403, so quiz ids cannot be enumerated.

import path from 'node:path';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { pool, query, transaction } from '../db.js';
import { requireUser, requireConfirmed } from '../auth/index.js';
import { validateQuiz, OPTION_LETTERS } from './validate.js';
import { toCsv, csvFilename } from './csv.js';

export const quizzesRouter = Router();

// Resolved the same way as in server.js.
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const webDir = path.resolve(rootDir, config.webDir);

// ---- Helpers ----

// Invalid ids return null (and so 404). 18 digits stays within bigint.
function parseId(value) {
  return /^[1-9][0-9]{0,17}$/.test(value) ? value : null;
}

function quizNotFound(res) {
  return res.status(404).json({ error: 'Quiz not found' });
}

// Null unless `userId` owns it. `db` is the pool or a transaction client.
async function findOwnedQuiz(db, id, userId, { lock = false } = {}) {
  if (id === null) return null;
  const { rows } = await db.query(
    `SELECT id, owner_id, title, mode, due_at, share_slug, created_at, updated_at
       FROM quizzes
      WHERE id = $1 AND owner_id = $2
      ${lock ? 'FOR UPDATE' : ''}`,
    [id, userId],
  );
  return rows[0] ?? null;
}

// Omits easily confused characters (0/o, 1/l/i).
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const SLUG_LENGTH = 8;

function randomSlug() {
  let slug = '';
  for (let i = 0; i < SLUG_LENGTH; i += 1) {
    slug += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)];
  }
  return slug;
}

// Retries on a slug clash. ON CONFLICT DO NOTHING avoids an error that would
// abort the surrounding transaction.
async function insertQuizRow(client, ownerId, { title, mode, due_at }) {
  for (let tries = 0; tries < 5; tries += 1) {
    const { rows } = await client.query(
      `INSERT INTO quizzes (owner_id, title, mode, due_at, share_slug)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (share_slug) DO NOTHING
       RETURNING id, share_slug`,
      [ownerId, title, mode, due_at, randomSlug()],
    );
    if (rows.length > 0) return rows[0];
  }
  throw new Error('Could not find an unused share slug after 5 tries');
}

async function insertQuestions(client, quizId, questions) {
  for (const [i, q] of questions.entries()) {
    await client.query(
      `INSERT INTO questions
         (quiz_id, position, prompt, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [quizId, i + 1, q.prompt, q.options.A, q.options.B, q.options.C, q.options.D, q.correct_option, q.time_limit_seconds],
    );
  }
}

async function loadQuestions(db, quizId) {
  const { rows } = await db.query(
    `SELECT id, position, prompt, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds
       FROM questions
      WHERE quiz_id = $1
      ORDER BY position`,
    [quizId],
  );
  return rows.map((row) => ({
    id: row.id,
    position: row.position,
    prompt: row.prompt,
    options: { A: row.option_a, B: row.option_b, C: row.option_c, D: row.option_d },
    correct_option: row.correct_option,
    time_limit_seconds: row.time_limit_seconds,
  }));
}

function sameQuestions(saved, submitted) {
  if (saved.length !== submitted.length) return false;
  return saved.every((s, i) => {
    const q = submitted[i];
    return (
      s.prompt === q.prompt &&
      s.correct_option === q.correct_option &&
      s.time_limit_seconds === q.time_limit_seconds &&
      OPTION_LETTERS.every((letter) => s.options[letter] === q.options[letter])
    );
  });
}

// Questions are frozen once played (including by bots) or while a game is in
// lobby/running: replacing them would cascade-delete saved answers.
async function questionsLocked(db, quizId) {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM attempts WHERE quiz_id = $1)
         OR EXISTS (SELECT 1 FROM games WHERE quiz_id = $1 AND status IN ('lobby', 'running'))
         AS locked`,
    [quizId],
  );
  return rows[0].locked;
}

const LOCKED_MESSAGE =
  'This quiz has already been played, so its questions can’t change: the results point at them. ' +
  'You can still change the title and due date, or duplicate the quiz to make a new version.';

function sendValidationErrors(res, errors) {
  const summary = errors.length === 1 ? errors[0].message : `Please fix ${errors.length} problems (first: ${errors[0].message})`;
  return res.status(400).json({ error: summary, code: 'invalid', errors });
}

// ---- My quizzes ----

quizzesRouter.get('/api/quizzes', requireUser, async (req, res) => {
  // Excludes bots, matching the results page.
  const { rows } = await query(
    `SELECT q.id, q.title, q.mode, q.due_at, q.share_slug, q.created_at, q.updated_at,
            (SELECT count(*) FROM questions WHERE quiz_id = q.id)::int AS question_count,
            (SELECT count(*)
               FROM attempts a
               JOIN users u ON u.id = a.user_id
              WHERE a.quiz_id = q.id AND NOT u.is_bot)::int AS attempt_count
       FROM quizzes q
      WHERE q.owner_id = $1
      ORDER BY q.updated_at DESC, q.id DESC`,
    [req.user.id],
  );
  res.json({ quizzes: rows });
});

// ---- Create ----

quizzesRouter.post('/api/quizzes', requireConfirmed, async (req, res) => {
  const { quiz, errors } = validateQuiz(req.body);
  if (errors) return sendValidationErrors(res, errors);

  const created = await transaction(async (client) => {
    const row = await insertQuizRow(client, req.user.id, quiz);
    await insertQuestions(client, row.id, quiz.questions);
    return row;
  });

  logger.info(
    { event: 'quiz.created', quiz_id: created.id, player_id: req.user.id, mode: quiz.mode, question_count: quiz.questions.length },
    'Quiz created',
  );
  res.status(201).json({ id: created.id, share_slug: created.share_slug });
});

// ---- Read one (with the correct answers: owner only) ----

quizzesRouter.get('/api/quizzes/:id', requireUser, async (req, res) => {
  const quiz = await findOwnedQuiz(pool, parseId(req.params.id), req.user.id);
  if (!quiz) return quizNotFound(res);

  const questions = await loadQuestions(pool, quiz.id);
  const { rows } = await query(
    `SELECT count(*)::int AS attempt_count
       FROM attempts a JOIN users u ON u.id = a.user_id
      WHERE a.quiz_id = $1 AND NOT u.is_bot`,
    [quiz.id],
  );

  res.json({
    id: quiz.id,
    title: quiz.title,
    mode: quiz.mode,
    due_at: quiz.due_at,
    share_slug: quiz.share_slug,
    created_at: quiz.created_at,
    updated_at: quiz.updated_at,
    attempt_count: rows[0].attempt_count,
    questions_locked: await questionsLocked(pool, quiz.id),
    questions,
  });
});

// ---- Update: replace title, mode, due date and questions in one go ----

quizzesRouter.put('/api/quizzes/:id', requireConfirmed, async (req, res) => {
  const id = parseId(req.params.id);

  // FOR UPDATE serialises concurrent saves of the same quiz.
  const outcome = await transaction(async (client) => {
    const existing = await findOwnedQuiz(client, id, req.user.id, { lock: true });
    if (!existing) return { status: 404 };

    const { quiz, errors } = validateQuiz(req.body, { currentDueAt: existing.due_at });
    if (errors) return { status: 400, errors };

    const saved = await loadQuestions(client, existing.id);
    const questionsChanged = !sameQuestions(saved, quiz.questions);
    if (questionsChanged && (await questionsLocked(client, existing.id))) {
      return { status: 409 };
    }

    await client.query(
      `UPDATE quizzes
          SET title = $2, mode = $3, due_at = $4, updated_at = now()
        WHERE id = $1`,
      [existing.id, quiz.title, quiz.mode, quiz.due_at],
    );
    if (questionsChanged) {
      await client.query('DELETE FROM questions WHERE quiz_id = $1', [existing.id]);
      await insertQuestions(client, existing.id, quiz.questions);
    }
    return { status: 200, questionsChanged, questionCount: quiz.questions.length };
  });

  if (outcome.status === 404) return quizNotFound(res);
  if (outcome.status === 400) return sendValidationErrors(res, outcome.errors);
  if (outcome.status === 409) {
    logger.info({ event: 'quiz.update_refused', quiz_id: id, player_id: req.user.id, reason: 'already_played' }, 'Quiz update refused');
    return res.status(409).json({ error: LOCKED_MESSAGE, code: 'questions_locked' });
  }

  logger.info(
    {
      event: 'quiz.updated',
      quiz_id: id,
      player_id: req.user.id,
      questions_replaced: outcome.questionsChanged,
      question_count: outcome.questionCount,
    },
    'Quiz updated',
  );
  res.json({ id });
});

// ---- Duplicate: same questions, "(copy)" title, new share link, no results ----

quizzesRouter.post('/api/quizzes/:id/duplicate', requireConfirmed, async (req, res) => {
  const sourceId = parseId(req.params.id);

  const copy = await transaction(async (client) => {
    const source = await findOwnedQuiz(client, sourceId, req.user.id);
    if (!source) return null;

    // Stays within the 120-character title limit.
    const suffix = ' (copy)';
    const title = source.title.slice(0, 120 - suffix.length) + suffix;

    const row = await insertQuizRow(client, req.user.id, { title, mode: source.mode, due_at: source.due_at });
    await client.query(
      `INSERT INTO questions
         (quiz_id, position, prompt, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds)
       SELECT $2, position, prompt, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds
         FROM questions
        WHERE quiz_id = $1`,
      [source.id, row.id],
    );
    return row;
  });

  if (!copy) return quizNotFound(res);

  logger.info(
    { event: 'quiz.duplicated', quiz_id: copy.id, source_quiz_id: sourceId, player_id: req.user.id },
    'Quiz duplicated',
  );
  res.status(201).json({ id: copy.id, share_slug: copy.share_slug });
});

// ---- Delete (its games, attempts and answers go with it: ON DELETE CASCADE) ----

quizzesRouter.delete('/api/quizzes/:id', requireUser, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return quizNotFound(res);

  const { rowCount } = await query('DELETE FROM quizzes WHERE id = $1 AND owner_id = $2', [id, req.user.id]);
  if (rowCount === 0) return quizNotFound(res);

  logger.info({ event: 'quiz.deleted', quiz_id: id, player_id: req.user.id }, 'Quiz deleted');
  res.status(204).end();
});

// ---- Results ----

// Excludes bots. Unfinished attempts are included with completed_at = null.
async function loadResults(quizId) {
  const { rows } = await query(
    `SELECT a.id AS attempt_id,
            u.name AS player_name,
            u.email,
            a.score,
            a.correct_count,
            a.rank,
            a.started_at,
            a.completed_at,
            CASE WHEN a.game_id IS NULL THEN 'self_paced' ELSE 'live' END AS kind,
            a.game_id,
            g.started_at AS game_started_at
       FROM attempts a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN games g ON g.id = a.game_id
      WHERE a.quiz_id = $1
        AND NOT u.is_bot
      ORDER BY coalesce(g.started_at, a.started_at) DESC, a.game_id, a.rank NULLS LAST, a.score DESC, a.id`,
    [quizId],
  );
  return rows;
}

quizzesRouter.get('/api/quizzes/:id/results', requireUser, async (req, res) => {
  const quiz = await findOwnedQuiz(pool, parseId(req.params.id), req.user.id);
  if (!quiz) return quizNotFound(res);

  const attempts = await loadResults(quiz.id);
  const total = attempts.reduce((sum, a) => sum + a.score, 0);

  res.json({
    quiz: { id: quiz.id, title: quiz.title, mode: quiz.mode, share_slug: quiz.share_slug },
    summary: {
      attempt_count: attempts.length,
      average_score: attempts.length > 0 ? Math.round(total / attempts.length) : null,
    },
    attempts,
  });
});

quizzesRouter.get('/api/quizzes/:id/results.csv', requireUser, async (req, res) => {
  const quiz = await findOwnedQuiz(pool, parseId(req.params.id), req.user.id);
  if (!quiz) return quizNotFound(res);

  const attempts = await loadResults(quiz.id);
  const csv = toCsv(
    ['name', 'email', 'score', 'correct_count', 'rank', 'completed_at', 'mode', 'game_started_at'],
    attempts.map((a) => [a.player_name, a.email, a.score, a.correct_count, a.rank, a.completed_at, a.kind, a.game_started_at]),
  );

  logger.info({ event: 'quiz.results_exported', quiz_id: quiz.id, player_id: req.user.id, row_count: attempts.length }, 'Results exported');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${csvFilename(quiz.title)}"`);
  res.send(csv);
});

// ---- Share links (public: anyone with the link) ----

// Public: never includes questions or answers.
quizzesRouter.get('/api/q/:slug', async (req, res) => {
  const { rows } = await query(
    `SELECT q.title, q.mode, q.due_at, q.share_slug,
            u.name AS owner_name,
            (SELECT count(*) FROM questions WHERE quiz_id = q.id)::int AS question_count
       FROM quizzes q
       JOIN users u ON u.id = q.owner_id
      WHERE q.share_slug = $1`,
    [req.params.slug],
  );
  if (rows.length === 0) return quizNotFound(res);
  res.json(rows[0]);
});

// Always serves q.html; the page reads the slug and calls /api/q/:slug.
quizzesRouter.get('/q/:slug', (req, res, next) => {
  res.sendFile(path.join(webDir, 'q.html'), (err) => {
    if (err) next(err);
  });
});
