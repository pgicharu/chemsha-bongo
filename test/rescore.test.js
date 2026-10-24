// Tests for scripts/rescore.js recompute and the deadline/judging rules in src/game/scoring.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deadlineAtMs, judgeAnswer, LATE_GRACE_MS } from '../src/game/scoring.js';

// Required by config.js via db.js; the pool never connects.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:1/test';
process.env.SESSION_SECRET ??= 'test';
const { recomputeAnswer, recomputeQuiz } = await import('../scripts/rescore.js');

const SHOWN = 1_000_000;
const LIMIT_S = 20;
const DEADLINE = SHOWN + 20_000;

test('deadlineAtMs: shown time plus the time limit in seconds', () => {
  assert.equal(deadlineAtMs(SHOWN, LIMIT_S), DEADLINE);
  assert.equal(deadlineAtMs(0, 5), 5_000);
});

test('judgeAnswer: correct, wrong, inside the grace window, and late', () => {
  const base = { correctOption: 'B', shownAtMs: SHOWN, timeLimitSeconds: LIMIT_S };
  assert.deepEqual(judgeAnswer({ ...base, option: 'B', receivedAtMs: SHOWN }), { result: 'correct', points: 1000 });
  assert.deepEqual(judgeAnswer({ ...base, option: 'B', receivedAtMs: SHOWN + 10_000 }), { result: 'correct', points: 750 });
  assert.deepEqual(judgeAnswer({ ...base, option: 'A', receivedAtMs: SHOWN + 1_000 }), { result: 'wrong', points: 0 });
  assert.deepEqual(judgeAnswer({ ...base, option: 'B', receivedAtMs: DEADLINE + LATE_GRACE_MS }), { result: 'correct', points: 500 });
  assert.deepEqual(judgeAnswer({ ...base, option: 'B', receivedAtMs: DEADLINE + LATE_GRACE_MS + 1 }), { result: 'late', points: 0 });
});

// A stored answer row, as the script loads it.
function answer(overrides) {
  return {
    id: '1',
    attemptId: '10',
    questionNo: 1,
    result: 'correct',
    points: 750,
    deadlineAtMs: DEADLINE,
    shownAtMs: SHOWN,
    receivedAtMs: SHOWN + 10_000,
    chosenOption: 'B',
    correctOption: 'B',
    timeLimitSeconds: LIMIT_S,
    ...overrides,
  };
}

test('recomputeAnswer ignores the stored deadline and recomputes it from shown_at', () => {
  // Deadline stored 15 s too early, so this in-time answer was judged late.
  const buggy = answer({ result: 'late', points: 0, deadlineAtMs: SHOWN + 5_000 });
  assert.deepEqual(recomputeAnswer(buggy), { result: 'correct', points: 750, deadlineAtMs: DEADLINE });
});

test('recomputeAnswer keeps really late answers late', () => {
  const late = answer({ result: 'late', points: 0, receivedAtMs: DEADLINE + 5_000 });
  assert.deepEqual(recomputeAnswer(late), { result: 'late', points: 0, deadlineAtMs: DEADLINE });
});

test("recomputeAnswer: a 'none' row (nothing received) stays none", () => {
  const none = answer({ result: 'none', points: 0, receivedAtMs: null, chosenOption: null, deadlineAtMs: SHOWN });
  assert.deepEqual(recomputeAnswer(none), { result: 'none', points: 0, deadlineAtMs: DEADLINE });
});

test('recomputeQuiz: repairs answers, totals and ranks, and reports only changes', () => {
  const attempts = [
    // Game 5 (finished): one correct answer was misjudged late by the bug.
    { id: '10', gameId: '5', gameFinished: true, score: 1000, correctCount: 1, rank: 1 },
    { id: '11', gameId: '5', gameFinished: true, score: 1000, correctCount: 1, rank: 1 },
    { id: '12', gameId: '5', gameFinished: true, score: 0, correctCount: 0, rank: 3 },
    { id: '20', gameId: null, gameFinished: false, score: 1000, correctCount: 1, rank: null },
  ];
  const answers = [
    answer({ id: '1', attemptId: '10', result: 'correct', points: 1000, receivedAtMs: SHOWN }),
    answer({ id: '2', attemptId: '10', questionNo: 2, result: 'late', points: 0, deadlineAtMs: SHOWN + 5_000 }),
    answer({ id: '3', attemptId: '11', result: 'correct', points: 1000, receivedAtMs: SHOWN }),
    answer({ id: '4', attemptId: '12', result: 'none', points: 0, receivedAtMs: null, chosenOption: null }),
    answer({ id: '5', attemptId: '20', result: 'correct', points: 1000, receivedAtMs: SHOWN }),
  ];

  const changes = recomputeQuiz({ answers, attempts });

  assert.deepEqual(
    changes.answers.map((a) => [a.id, a.after]),
    [['2', { result: 'correct', points: 750, deadlineAtMs: DEADLINE }]],
  );
  assert.deepEqual(
    changes.attempts.map((a) => [a.id, a.after]),
    [
      ['10', { score: 1750, correctCount: 2, rank: 1 }],
      ['11', { score: 1000, correctCount: 1, rank: 2 }],
    ],
  );
});

test('recomputeQuiz: running it on repaired data changes nothing (idempotent)', () => {
  const attempts = [{ id: '10', gameId: '5', gameFinished: true, score: 1750, correctCount: 2, rank: 1 }];
  const answers = [
    answer({ id: '1', attemptId: '10', result: 'correct', points: 1000, receivedAtMs: SHOWN }),
    answer({ id: '2', attemptId: '10', questionNo: 2 }),
  ];
  assert.deepEqual(recomputeQuiz({ answers, attempts }), { answers: [], attempts: [] });
});

test('recomputeQuiz: games that never finished keep their (empty) ranks', () => {
  const attempts = [{ id: '10', gameId: '6', gameFinished: false, score: 0, correctCount: 0, rank: null }];
  const answers = [answer({ attemptId: '10', result: 'late', points: 0, deadlineAtMs: SHOWN })];
  const changes = recomputeQuiz({ answers, attempts });
  assert.deepEqual(changes.attempts[0].after, { score: 750, correctCount: 1, rank: null });
});
