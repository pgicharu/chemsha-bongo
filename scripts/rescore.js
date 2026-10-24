#!/usr/bin/env node
// Re-scores a quiz from its stored answers with the current rules in
// src/game/scoring.js, repairing answers (result, points, deadline_at) and
// attempts (score, correct_count, live-game rank).
//
//   npm run rescore -- --quiz 12 [--dry-run]
//   docker compose exec app npm run rescore -- --quiz 12 --dry-run
//
// The stored deadline_at is not trusted: it was written by the same code that
// made the original decision, so it is recomputed from shown_at. 'none' rows
// stay 'none'. Runs in one transaction (rolled back on error or --dry-run) and
// refuses while a live game of the quiz is open, since that game's in-memory
// scores would overwrite the repair.

import { query, transaction, pool } from '../src/db.js';
import { logger } from '../src/logger.js';
import { judgeAnswer, deadlineAtMs, rankByScore } from '../src/game/scoring.js';

// ---------------------------------------------------------------------------
// Recompute (pure functions)
// ---------------------------------------------------------------------------

export function recomputeAnswer(answer) {
  const deadline = deadlineAtMs(answer.shownAtMs, answer.timeLimitSeconds);
  if (answer.receivedAtMs === null) {
    return { result: 'none', points: 0, deadlineAtMs: deadline };
  }
  const { result, points } = judgeAnswer({
    option: answer.chosenOption,
    correctOption: answer.correctOption,
    shownAtMs: answer.shownAtMs,
    timeLimitSeconds: answer.timeLimitSeconds,
    receivedAtMs: answer.receivedAtMs,
  });
  return { result, points, deadlineAtMs: deadline };
}

// Returns only the answers and attempts that changed, each with an `after` field.
export function recomputeQuiz({ answers, attempts }) {
  const totals = new Map(attempts.map((a) => [a.id, { score: 0, correctCount: 0 }]));
  const changedAnswers = [];

  for (const answer of answers) {
    const after = recomputeAnswer(answer);
    if (after.result === 'correct') {
      const total = totals.get(answer.attemptId);
      total.score += after.points;
      total.correctCount += 1;
    }
    if (after.result !== answer.result || after.points !== answer.points || after.deadlineAtMs !== answer.deadlineAtMs) {
      changedAnswers.push({ ...answer, after });
    }
  }

  // Only finished live games have ranks.
  const newRanks = new Map();
  const finishedGames = new Set(attempts.filter((a) => a.gameId !== null && a.gameFinished).map((a) => a.gameId));
  for (const gameId of finishedGames) {
    const players = attempts.filter((a) => a.gameId === gameId).map((a) => ({ id: a.id, score: totals.get(a.id).score }));
    for (const ranked of rankByScore(players)) newRanks.set(ranked.id, ranked.rank);
  }

  const changedAttempts = [];
  for (const attempt of attempts) {
    const after = { ...totals.get(attempt.id), rank: newRanks.get(attempt.id) ?? attempt.rank };
    if (after.score !== attempt.score || after.correctCount !== attempt.correctCount || after.rank !== attempt.rank) {
      changedAttempts.push({ ...attempt, after });
    }
  }

  return { answers: changedAnswers, attempts: changedAttempts };
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  npm run rescore -- --quiz <id> [--dry-run]`;

function fail(message) {
  console.error(`rescore: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv) {
  let quizId = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--quiz') {
      quizId = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--quiz=')) quizId = arg.slice('--quiz='.length);
    else fail(`unknown argument "${arg}"`);
  }
  if (!/^[1-9][0-9]{0,17}$/.test(quizId ?? '')) fail('--quiz must be a quiz id, e.g. --quiz 12');
  return { quizId, dryRun };
}

// FOR UPDATE makes a concurrent self-paced answer wait for the repair instead
// of being lost in it.
async function loadQuiz(client, quizId) {
  const { rows: attempts } = await client.query(
    `SELECT a.id, a.game_id, g.status AS game_status, a.score, a.correct_count, a.rank,
            u.name AS player_name, u.is_bot
       FROM attempts a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN games g ON g.id = a.game_id
      WHERE a.quiz_id = $1
      ORDER BY a.game_id NULLS FIRST, a.id
        FOR UPDATE OF a`,
    [quizId],
  );
  const { rows: answers } = await client.query(
    `SELECT an.id, an.attempt_id, an.question_no, an.result, an.points, an.chosen_option,
            an.shown_at, an.deadline_at, an.received_at,
            q.correct_option, q.time_limit_seconds
       FROM answers an
       JOIN attempts a ON a.id = an.attempt_id
       JOIN questions q ON q.id = an.question_id
      WHERE a.quiz_id = $1
      ORDER BY an.attempt_id, an.question_no`,
    [quizId],
  );
  return {
    attempts: attempts.map((a) => ({
      id: a.id,
      gameId: a.game_id,
      gameFinished: a.game_status === 'finished',
      score: a.score,
      correctCount: a.correct_count,
      rank: a.rank,
      playerName: a.player_name + (a.is_bot ? ' (bot)' : ''),
    })),
    answers: answers.map((r) => ({
      id: r.id,
      attemptId: r.attempt_id,
      questionNo: r.question_no,
      result: r.result,
      points: r.points,
      chosenOption: r.chosen_option,
      shownAtMs: r.shown_at.getTime(),
      deadlineAtMs: r.deadline_at.getTime(),
      receivedAtMs: r.received_at === null ? null : r.received_at.getTime(),
      correctOption: r.correct_option,
      timeLimitSeconds: r.time_limit_seconds,
    })),
  };
}

async function save(client, changes) {
  for (const answer of changes.answers) {
    await client.query('UPDATE answers SET result = $2, points = $3, deadline_at = $4 WHERE id = $1', [
      answer.id,
      answer.after.result,
      answer.after.points,
      new Date(answer.after.deadlineAtMs),
    ]);
  }
  for (const attempt of changes.attempts) {
    await client.query('UPDATE attempts SET score = $2, correct_count = $3, rank = $4 WHERE id = $1', [
      attempt.id,
      attempt.after.score,
      attempt.after.correctCount,
      attempt.after.rank,
    ]);
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const time = (ms) => new Date(ms).toISOString().slice(11, 23); // "17:03:12.123" (UTC)
const arrow = (before, after) => (before === after ? String(after) : `${before ?? '–'} → ${after ?? '–'}`);

function printSummary(loaded, changes) {
  const answersByAttempt = Map.groupBy(changes.answers, (a) => a.attemptId);
  const attemptsById = new Map(loaded.attempts.map((a) => [a.id, a]));
  const changedAttempts = new Map(changes.attempts.map((a) => [a.id, a]));
  const ids = new Set([...answersByAttempt.keys(), ...changedAttempts.keys()]);

  for (const id of [...ids].sort((x, y) => Number(x) - Number(y))) {
    const attempt = attemptsById.get(id);
    const where = attempt.gameId ? `live game ${attempt.gameId}` : 'self-paced';
    console.log(`\n${attempt.playerName}  (attempt ${id}, ${where})`);
    for (const a of answersByAttempt.get(id) ?? []) {
      const deadline = a.deadlineAtMs === a.after.deadlineAtMs ? '' : `   deadline ${time(a.deadlineAtMs)} → ${time(a.after.deadlineAtMs)} UTC`;
      console.log(`  Q${a.questionNo}  ${a.result} ${a.points} → ${a.after.result} ${a.after.points}${deadline}`);
    }
    const changed = changedAttempts.get(id);
    if (changed) {
      const rank = changed.rank === changed.after.rank ? '' : ` · rank ${arrow(changed.rank, changed.after.rank)}`;
      console.log(
        `  score ${arrow(changed.score, changed.after.score)} · correct ${arrow(changed.correctCount, changed.after.correctCount)}${rank}`,
      );
    }
  }
}

async function main() {
  const { quizId, dryRun } = parseArgs(process.argv.slice(2));
  const startedMs = Date.now();

  const { rows: quizzes } = await query('SELECT id, title, mode FROM quizzes WHERE id = $1', [quizId]);
  if (quizzes.length === 0) fail(`no quiz with id ${quizId}`);
  const quiz = quizzes[0];

  const { rows: open } = await query(`SELECT id FROM games WHERE quiz_id = $1 AND status IN ('lobby', 'running')`, [quizId]);
  if (open.length > 0) {
    fail(`game ${open.map((g) => g.id).join(', ')} of this quiz is still open. Run this again once it has finished.`);
  }

  console.log(`Rescoring quiz ${quiz.id} "${quiz.title}" (${quiz.mode})${dryRun ? '. DRY RUN: nothing will be saved.' : ''}`);

  const { loaded, changes } = await transaction(async (client) => {
    const found = await loadQuiz(client, quizId);
    const recomputed = recomputeQuiz(found);
    if (!dryRun) await save(client, recomputed); // a dry run only reads
    return { loaded: found, changes: recomputed };
  });
  printSummary(loaded, changes);
  const ranksChanged = changes.attempts.filter((a) => a.rank !== a.after.rank).length;
  let outcome = 'Saved.';
  if (dryRun) outcome = 'Dry run: nothing was saved.';
  else if (changes.answers.length + changes.attempts.length === 0) outcome = 'Nothing to fix.';
  console.log(
    `\nChecked ${plural(loaded.answers.length, 'answer')} in ${plural(loaded.attempts.length, 'attempt')}. ` +
      `Changed: ${plural(changes.answers.length, 'answer')}, ${plural(changes.attempts.length, 'attempt')}, ${plural(ranksChanged, 'rank')}. ${outcome}`,
  );

  logger.info(
    {
      event: 'rescore.finished',
      quiz_id: quiz.id,
      dry_run: dryRun,
      answers_checked: loaded.answers.length,
      answers_changed: changes.answers.length,
      attempts_changed: changes.attempts.length,
      ranks_changed: ranksChanged,
      duration_ms: Date.now() - startedMs,
    },
    dryRun ? 'Rescore dry run finished' : 'Rescore finished',
  );
}

// Tests import the functions above.
if (import.meta.main) {
  main()
    .then(() => pool.end())
    .catch(async (err) => {
      logger.error({ event: 'rescore.failed', err }, 'Rescore failed');
      await pool.end();
      process.exit(1);
    });
}
