// Tests for src/game/scoring.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LATE_GRACE_MS, isLate, timeTakenMs, scoreAnswer, rankByScore } from '../src/game/scoring.js';

const LIMIT = 20_000; // a 20-second question
const SHOWN = 1_000_000; // any fixed "shown at" time
const DEADLINE = SHOWN + LIMIT;

// Score a correct answer received `afterMs` after the question was shown.
function correctAfter(afterMs) {
  return scoreAnswer({ correct: true, timeTakenMs: timeTakenMs(SHOWN, SHOWN + afterMs, LIMIT), timeLimitMs: LIMIT });
}

test('the grace window is one second', () => {
  assert.equal(LATE_GRACE_MS, 1000);
});

test('isLate: before, at and just after the deadline are all in time', () => {
  assert.equal(isLate(SHOWN, DEADLINE), false);
  assert.equal(isLate(DEADLINE - 1, DEADLINE), false);
  assert.equal(isLate(DEADLINE, DEADLINE), false);
  assert.equal(isLate(DEADLINE + 1, DEADLINE), false);
  assert.equal(isLate(DEADLINE + 500, DEADLINE), false);
});

test('isLate: exactly at the end of the grace window still counts', () => {
  assert.equal(isLate(DEADLINE + LATE_GRACE_MS, DEADLINE), false);
});

test('isLate: one millisecond past the grace window is late', () => {
  assert.equal(isLate(DEADLINE + LATE_GRACE_MS + 1, DEADLINE), true);
  assert.equal(isLate(DEADLINE + 60_000, DEADLINE), true);
});

test('timeTakenMs is clamped to [0, timeLimit]', () => {
  assert.equal(timeTakenMs(SHOWN, SHOWN, LIMIT), 0);
  assert.equal(timeTakenMs(SHOWN, SHOWN + 7_500, LIMIT), 7_500);
  assert.equal(timeTakenMs(SHOWN, SHOWN - 50, LIMIT), 0);
  assert.equal(timeTakenMs(SHOWN, DEADLINE + 800, LIMIT), LIMIT);
});

test('a correct instant answer earns 1000', () => {
  assert.equal(correctAfter(0), 1000);
});

test('a correct answer at half time earns 750', () => {
  assert.equal(correctAfter(LIMIT / 2), 750);
});

test('a correct answer exactly at the deadline earns 500', () => {
  assert.equal(correctAfter(LIMIT), 500);
});

test('a correct answer inside the grace window earns 500', () => {
  assert.equal(correctAfter(LIMIT + 1), 500);
  assert.equal(correctAfter(LIMIT + LATE_GRACE_MS), 500);
});

test('points fall linearly and are rounded to whole numbers', () => {
  assert.equal(correctAfter(1_000), 975);
  assert.equal(correctAfter(5_000), 875);
  assert.equal(correctAfter(15_000), 625);
  assert.equal(correctAfter(1), 1000);
  assert.equal(scoreAnswer({ correct: true, timeTakenMs: 3, timeLimitMs: 7_000 }), 1000);
  assert.equal(scoreAnswer({ correct: true, timeTakenMs: 1_000, timeLimitMs: 7_000 }), 929);
});

test('points never go above 1000 or below 500 for a correct answer', () => {
  for (let ms = -1_000; ms <= LIMIT + 5_000; ms += 250) {
    const points = correctAfter(ms);
    assert.ok(points >= 500 && points <= 1000, `${ms} ms gave ${points}`);
  }
  assert.equal(scoreAnswer({ correct: true, timeTakenMs: LIMIT * 3, timeLimitMs: LIMIT }), 500);
  assert.equal(scoreAnswer({ correct: true, timeTakenMs: -500, timeLimitMs: LIMIT }), 1000);
});

test('a wrong answer earns 0 at any time', () => {
  assert.equal(scoreAnswer({ correct: false, timeTakenMs: 0, timeLimitMs: LIMIT }), 0);
  assert.equal(scoreAnswer({ correct: false, timeTakenMs: LIMIT, timeLimitMs: LIMIT }), 0);
});

test('rankByScore sorts highest first and shares ranks on ties', () => {
  const ranked = rankByScore([
    { id: 1, score: 500 },
    { id: 2, score: 1800 },
    { id: 3, score: 900 },
    { id: 4, score: 900 },
    { id: 5, score: 0 },
  ]);
  assert.deepEqual(
    ranked.map((p) => [p.id, p.rank]),
    [
      [2, 1],
      [3, 2],
      [4, 2],
      [1, 4],
      [5, 5],
    ],
  );
});

test('rankByScore handles no players and does not change its input', () => {
  assert.deepEqual(rankByScore([]), []);
  const input = [{ id: 1, score: 1 }, { id: 2, score: 2 }];
  rankByScore(input);
  assert.deepEqual(input, [{ id: 1, score: 1 }, { id: 2, score: 2 }]);
});
