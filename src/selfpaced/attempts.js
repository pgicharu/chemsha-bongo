// Self-paced attempts: start one, serve its questions, take its answers.
// All state lives in Postgres (attempts, answers), so a refresh or restart resumes.
// Answers are written by the live game's processAnswer (src/game/engine.js).

import { query } from '../db.js';
import { logger } from '../logger.js';
import { processAnswer, OPTIONS } from '../game/engine.js';
import { deadlineAtMs } from '../game/scoring.js';
import { planNext, isPastDue, remainingMs } from './rules.js';

// `message` is safe to show to the player.
export class SelfPacedError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Serialises requests per player so a double tap or two tabs cannot score the
// same question twice. In-memory: assumes a single app process.
const queues = new Map(); // 'quizId:userId' -> the promise of the latest request

export async function oneAtATime(key, work) {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  const tail = current.catch(() => {});
  queues.set(key, tail);
  try {
    return await current;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

export async function findSelfPacedQuiz(slug) {
  const { rows } = await query(
    `SELECT q.id, q.owner_id, q.title, q.mode, q.due_at,
            (SELECT count(*) FROM questions WHERE quiz_id = q.id)::int AS question_count
       FROM quizzes q
      WHERE q.share_slug = $1`,
    [slug],
  );
  const quiz = rows[0];
  if (!quiz) throw new SelfPacedError(404, 'not_found', 'Quiz not found');
  if (quiz.mode !== 'self_paced') {
    throw new SelfPacedError(400, 'not_self_paced', 'This is a live quiz. Ask the host for the game code to play it.');
  }
  return quiz;
}

// `answered` counts all answers rows, including 'none'.
async function findAttempt(quizId, userId) {
  const { rows } = await query(
    `SELECT a.id, a.score, a.correct_count, a.started_at, a.completed_at,
            a.current_question_no, a.current_shown_at,
            (SELECT count(*) FROM answers WHERE attempt_id = a.id)::int AS answered,
            EXISTS (SELECT 1 FROM answers
                     WHERE attempt_id = a.id AND question_no = a.current_question_no) AS current_answered
       FROM attempts a
      WHERE a.quiz_id = $1 AND a.user_id = $2 AND a.game_id IS NULL`,
    [quizId, userId],
  );
  return rows[0] ?? null;
}

async function requireAttempt(quiz, user) {
  const attempt = await findAttempt(quiz.id, user.id);
  if (!attempt) throw new SelfPacedError(409, 'not_started', 'Start the quiz first.');
  return attempt;
}

// questionNo is the 1-based position.
async function loadQuestion(quizId, questionNo) {
  const { rows } = await query(
    `SELECT id, prompt, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds
       FROM questions
      WHERE quiz_id = $1 AND position = $2`,
    [quizId, questionNo],
  );
  return rows[0];
}

const timeOf = (value) => (value === null ? null : new Date(value).getTime());

export async function startAttempt(quiz, user, nowMs) {
  if (String(quiz.owner_id) === String(user.id)) {
    throw new SelfPacedError(403, 'is_owner', "This is your own quiz. To try it, log in with a different account.");
  }
  if (quiz.question_count === 0) {
    throw new SelfPacedError(400, 'no_questions', 'This quiz has no questions yet.');
  }

  let attempt = await findAttempt(quiz.id, user.id);
  if (attempt?.completed_at) {
    throw new SelfPacedError(409, 'already_taken', "You've already taken this quiz. Each player gets one attempt.");
  }
  if (isPastDue(timeOf(quiz.due_at), nowMs)) {
    throw new SelfPacedError(410, 'past_due', 'This quiz is closed: its due date has passed.');
  }

  if (!attempt) {
    // The partial unique index keeps this to one attempt even under concurrent starts.
    await query(
      `INSERT INTO attempts (user_id, quiz_id) VALUES ($1, $2)
       ON CONFLICT (quiz_id, user_id) WHERE game_id IS NULL DO NOTHING`,
      [user.id, quiz.id],
    );
    attempt = await findAttempt(quiz.id, user.id);
    logger.info(
      { event: 'selfpaced.started', quiz_id: quiz.id, player_id: user.id, attempt_id: attempt.id, question_count: quiz.question_count },
      'Self-paced attempt started',
    );
  }

  return {
    attemptId: attempt.id,
    quizTitle: quiz.title,
    totalQuestions: quiz.question_count,
    dueAt: quiz.due_at,
    answered: attempt.answered,
  };
}

async function planFor(quiz, attempt, nowMs) {
  const servedNo = attempt.current_question_no ?? 0;
  const served = servedNo > 0 ? await loadQuestion(quiz.id, servedNo) : null;
  const plan = planNext({
    total: quiz.question_count,
    servedNo,
    servedShownAtMs: timeOf(attempt.current_shown_at),
    servedTimeLimitSeconds: served?.time_limit_seconds,
    servedAnswered: attempt.current_answered,
    dueAtMs: timeOf(quiz.due_at),
    nowMs,
  });
  return { plan, served };
}

async function expireQuestion(quiz, user, attempt, question) {
  const shownAtMs = timeOf(attempt.current_shown_at);
  await query(
    `INSERT INTO answers (attempt_id, question_id, question_no, result, points, shown_at, deadline_at)
     VALUES ($1, $2, $3, 'none', 0, $4, $5)
     ON CONFLICT (attempt_id, question_id) DO NOTHING`,
    [attempt.id, question.id, attempt.current_question_no, new Date(shownAtMs), new Date(deadlineAtMs(shownAtMs, question.time_limit_seconds))],
  );
  logger.info(
    { event: 'question.expired', quiz_id: quiz.id, player_id: user.id, question_no: attempt.current_question_no },
    'Time ran out with no answer',
  );
}

async function completeAttempt(quiz, user, attemptId, reason) {
  const { rows } = await query(
    `UPDATE attempts SET completed_at = now()
      WHERE id = $1 AND completed_at IS NULL
      RETURNING score, correct_count, started_at, completed_at`,
    [attemptId],
  );
  if (rows.length === 0) return; // already complete
  const done = rows[0];
  logger.info(
    {
      event: 'selfpaced.finished',
      quiz_id: quiz.id,
      player_id: user.id,
      attempt_id: attemptId,
      reason, // 'answered' | 'time_up'
      score: done.score,
      correct_count: done.correct_count,
      question_count: quiz.question_count,
      duration_ms: new Date(done.completed_at) - new Date(done.started_at),
    },
    'Self-paced attempt finished',
  );
}

function finishedPayload(attempt, quiz) {
  return { finished: true, score: attempt.score, correctCount: attempt.correct_count, total: quiz.question_count };
}

function questionPayload(quiz, questionNo, question, left) {
  return {
    questionNo,
    total: quiz.question_count,
    prompt: question.prompt,
    options: { A: question.option_a, B: question.option_b, C: question.option_c, D: question.option_d },
    timeLimitSeconds: question.time_limit_seconds,
    remainingMs: left,
  };
}

// Resends the open question with its real remaining time, or closes an
// expired one and serves the next.
export async function currentQuestion(quiz, user, nowMs) {
  const attempt = await requireAttempt(quiz, user);
  if (attempt.completed_at) return finishedPayload(attempt, quiz);

  const { plan, served } = await planFor(quiz, attempt, nowMs);
  if (plan.expire) await expireQuestion(quiz, user, attempt, served);

  if (plan.next === 'resume') {
    return questionPayload(quiz, plan.questionNo, served, plan.remainingMs);
  }
  if (plan.next === 'finished') {
    await completeAttempt(quiz, user, attempt.id, 'time_up');
    return finishedPayload(attempt, quiz);
  }
  if (plan.next === 'past_due') {
    throw new SelfPacedError(410, 'past_due', 'This quiz is closed: its due date has passed, so no more questions can be shown.');
  }

  const question = await loadQuestion(quiz.id, plan.questionNo);
  const shownAtMs = Date.now();
  await query('UPDATE attempts SET current_question_no = $2, current_shown_at = $3 WHERE id = $1', [
    attempt.id,
    plan.questionNo,
    new Date(shownAtMs),
  ]);
  logger.info(
    { event: 'question.shown', quiz_id: quiz.id, player_id: user.id, question_no: plan.questionNo, time_limit_ms: question.time_limit_seconds * 1000 },
    'Question shown',
  );
  return questionPayload(quiz, plan.questionNo, question, remainingMs(shownAtMs, question.time_limit_seconds, shownAtMs));
}

export async function submitAnswer(quiz, user, { questionNo, option }, receivedAtMs) {
  if (!Number.isSafeInteger(questionNo) || questionNo < 1) {
    throw new SelfPacedError(400, 'bad_request', 'questionNo must be a question number (1, 2, 3 ...).');
  }
  if (!OPTIONS.includes(option)) throw new SelfPacedError(400, 'bad_option', 'Pick A, B, C or D.');

  const attempt = await requireAttempt(quiz, user);
  if (attempt.completed_at) {
    throw new SelfPacedError(409, 'finished', "You've finished this quiz already.");
  }
  if (questionNo !== attempt.current_question_no) {
    throw new SelfPacedError(409, 'not_current', 'That is not the question you are on. Ask for the current question.');
  }
  if (attempt.current_answered) {
    throw new SelfPacedError(409, 'already_answered', 'You already answered this question.');
  }

  const question = await loadQuestion(quiz.id, questionNo);
  const { result, points } = await processAnswer({
    quizId: quiz.id,
    gameId: null,
    playerId: user.id,
    attemptId: attempt.id,
    questionNo,
    question: { id: question.id, correctOption: question.correct_option, timeLimitSeconds: question.time_limit_seconds },
    shownAtMs: timeOf(attempt.current_shown_at),
    option,
    receivedAtMs,
  });

  if (questionNo === quiz.question_count) await completeAttempt(quiz, user, attempt.id, 'answered');

  const { rows } = await query('SELECT score FROM attempts WHERE id = $1', [attempt.id]);
  return { result, points, totalScore: rows[0].score, correctOption: question.correct_option };
}

// Also completes the attempt if the last question ran out while the player was away.
export async function getResult(quiz, user, nowMs) {
  let attempt = await findAttempt(quiz.id, user.id);
  if (!attempt) throw new SelfPacedError(404, 'not_started', "You haven't started this quiz.");

  if (!attempt.completed_at) {
    const { plan, served } = await planFor(quiz, attempt, nowMs);
    if (plan.expire) await expireQuestion(quiz, user, attempt, served);
    if (plan.next === 'finished') {
      await completeAttempt(quiz, user, attempt.id, 'time_up');
      attempt = await findAttempt(quiz.id, user.id);
    }
  }

  return {
    finished: attempt.completed_at !== null,
    score: attempt.score,
    correctCount: attempt.correct_count,
    total: quiz.question_count,
    completedAt: attempt.completed_at,
  };
}
