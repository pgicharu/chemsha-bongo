// Tests for the self-paced rules (src/selfpaced/rules.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planNext, remainingMs, isPastDue } from '../src/selfpaced/rules.js';

const SHOWN = 1_000_000; // any fixed "served at" time
const LIMIT_S = 20; // a 20-second question
const DEADLINE = SHOWN + LIMIT_S * 1000;

// An attempt of a 3-question quiz with no due date, at question `servedNo`.
function plan(overrides) {
  return planNext({
    total: 3,
    servedNo: 0,
    servedShownAtMs: null,
    servedTimeLimitSeconds: null,
    servedAnswered: false,
    dueAtMs: null,
    nowMs: SHOWN,
    ...overrides,
  });
}

const served = (servedNo, nowMs, servedAnswered = false) => ({
  servedNo,
  servedShownAtMs: SHOWN,
  servedTimeLimitSeconds: LIMIT_S,
  servedAnswered,
  nowMs,
});

test('remainingMs counts down to the deadline and never goes below 0', () => {
  assert.equal(remainingMs(SHOWN, LIMIT_S, SHOWN), 20_000);
  assert.equal(remainingMs(SHOWN, LIMIT_S, SHOWN + 7_250), 12_750);
  assert.equal(remainingMs(SHOWN, LIMIT_S, DEADLINE), 0);
  assert.equal(remainingMs(SHOWN, LIMIT_S, DEADLINE + 5_000), 0);
});

test('isPastDue: no due date never closes; the due moment itself is closed', () => {
  assert.equal(isPastDue(null, Date.now()), false);
  assert.equal(isPastDue(5_000, 4_999), false);
  assert.equal(isPastDue(5_000, 5_000), true);
});

test('a new attempt serves question 1', () => {
  assert.deepEqual(plan({}), { expire: null, next: 'serve', questionNo: 1 });
});

test('an open question is resumed with the time really left (a refresh gives no extra time)', () => {
  assert.deepEqual(plan(served(2, SHOWN + 15_000)), { expire: null, next: 'resume', questionNo: 2, remainingMs: 5_000 });
});

test('an answered question moves on to the next one', () => {
  assert.deepEqual(plan(served(1, SHOWN + 3_000, true)), { expire: null, next: 'serve', questionNo: 2 });
});

test('a question whose time ran out with no answer is closed as none, then the next is served', () => {
  assert.deepEqual(plan(served(1, DEADLINE)), { expire: 1, next: 'serve', questionNo: 2 });
  assert.deepEqual(plan(served(1, DEADLINE + 60_000)), { expire: 1, next: 'serve', questionNo: 2 });
});

test('after the last question the attempt is finished, closing it first if it ran out', () => {
  assert.deepEqual(plan(served(3, SHOWN + 1_000, true)), { expire: null, next: 'finished' });
  assert.deepEqual(plan(served(3, DEADLINE + 1)), { expire: 3, next: 'finished' });
});

test('after the due date no new question is served, but an open one can still be finished', () => {
  const dueAtMs = SHOWN + 10_000;
  assert.deepEqual(plan({ ...served(1, SHOWN + 12_000), dueAtMs }), { expire: null, next: 'resume', questionNo: 1, remainingMs: 8_000 });
  assert.deepEqual(plan({ ...served(1, SHOWN + 12_000, true), dueAtMs }), { expire: null, next: 'past_due' });
  assert.deepEqual(plan({ ...served(1, DEADLINE + 1), dueAtMs }), { expire: 1, next: 'past_due' });
  assert.deepEqual(plan({ dueAtMs, nowMs: dueAtMs }), { expire: null, next: 'past_due' });
});
