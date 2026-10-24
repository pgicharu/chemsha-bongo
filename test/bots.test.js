// Tests for the bot players (src/bots/); no database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import session from 'express-session';

import { KENYAN_NAMES, pickBotName } from '../src/bots/names.js';
import { BEHAVIOUR, thinkTimeMs, planAnswer, chooseOption, correctLetterFor } from '../src/bots/behaviour.js';
import { LATE_GRACE_MS } from '../src/game/scoring.js';

// Required by config.js; nothing connects.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:1/test';
process.env.SESSION_SECRET ??= 'test';
const { sessionCookieHeader, sessionData, SESSION_COOKIE_NAME } = await import('../src/bots/sessions.js');
const { summarizeLiveBots } = await import('../src/bots/live-player.js');
const { shuffled } = await import('../src/bots/accounts.js');

// Deterministic stand-in for Math.random (LCG).
function seededRandom(seed = 42) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

const share = (list, predicate) => list.filter(predicate).length / list.length;

test('names: at least 50, no duplicates', () => {
  assert.ok(KENYAN_NAMES.length >= 50);
  assert.equal(new Set(KENYAN_NAMES).size, KENYAN_NAMES.length);
});

test('pickBotName: a free name while there is one, then numbered repeats', () => {
  const random = seededRandom();
  const taken = new Set();
  for (let i = 0; i < KENYAN_NAMES.length; i += 1) {
    const name = pickBotName(taken, random);
    assert.ok(KENYAN_NAMES.includes(name));
    assert.ok(!taken.has(name), `${name} picked twice`);
    taken.add(name);
  }
  const next = pickBotName(taken, () => 0);
  assert.equal(next, `${KENYAN_NAMES[0]} 2`);
  taken.add(next);
  assert.equal(pickBotName(taken, () => 0), `${KENYAN_NAMES[0]} 3`);
});

test('shuffled: same items, original untouched', () => {
  const list = [1, 2, 3, 4, 5];
  const copy = shuffled(list, seededRandom());
  assert.deepEqual([...copy].sort(), list);
  assert.deepEqual(list, [1, 2, 3, 4, 5]);
});

test('thinkTimeMs: mostly 2-10 s, some quick, a few slow', () => {
  const random = seededRandom(7);
  const times = Array.from({ length: 20_000 }, () => thinkTimeMs(random));
  const quick = share(times, (t) => t < 2000);
  const usual = share(times, (t) => t >= 2000 && t <= 10_000);
  const slow = share(times, (t) => t > 10_000);
  assert.ok(quick > 0.07 && quick < 0.13, `quick ${quick}`);
  assert.ok(usual > 0.75 && usual < 0.85, `usual ${usual}`);
  assert.ok(slow > 0.07 && slow < 0.13, `slow ${slow}`);
  assert.ok(times.every((t) => t >= 700 && t <= 20_000));
});

test('planAnswer: ~70% right, ~5% late, ~3% skipped; on-time answers beat the deadline', () => {
  const random = seededRandom(3);
  const remainingMs = 20_000;
  const plans = Array.from({ length: 20_000 }, () => planAnswer({ remainingMs, random }));

  const late = share(plans, (p) => p.kind === 'late');
  const skip = share(plans, (p) => p.kind === 'skip');
  assert.ok(Math.abs(late - BEHAVIOUR.lateShare) < 0.01, `late ${late}`);
  assert.ok(Math.abs(skip - BEHAVIOUR.skipShare) < 0.01, `skip ${skip}`);

  const answers = plans.filter((p) => p.kind === 'answer');
  const right = share(answers, (p) => p.correct);
  assert.ok(Math.abs(right - BEHAVIOUR.accuracy) < 0.02, `right ${right}`);
  assert.ok(answers.every((p) => p.delayMs > 0 && p.delayMs <= remainingMs - BEHAVIOUR.safetyMarginMs));

  for (const p of plans.filter((p) => p.kind === 'late')) {
    assert.ok(p.delayMs > remainingMs + LATE_GRACE_MS, `late answer at ${p.delayMs} ms`);
  }
});

test('planAnswer: no time left means no on-time answer', () => {
  const random = seededRandom(9);
  const plans = Array.from({ length: 2000 }, () => planAnswer({ remainingMs: 200, random }));
  assert.ok(plans.every((p) => p.kind !== 'answer'));
});

test('chooseOption: right answer when correct, one of the other three when not, a guess without a key', () => {
  const random = seededRandom(5);
  assert.equal(chooseOption({ correctLetter: 'C', correct: true, random }), 'C');
  for (let i = 0; i < 200; i += 1) {
    const wrong = chooseOption({ correctLetter: 'C', correct: false, random });
    assert.ok(['A', 'B', 'D'].includes(wrong));
  }
  assert.ok(['A', 'B', 'C', 'D'].includes(chooseOption({ correctLetter: null, correct: true, random })));
});

test('correctLetterFor: matches the prompt and the text of the right option', () => {
  const key = [
    { prompt: 'Capital of Kenya?', options: { A: 'Mombasa', B: 'Nairobi', C: 'Kisumu', D: 'Nakuru' }, correctOption: 'B' },
  ];
  assert.equal(correctLetterFor(key, key[0]), 'B');
  const shown = { prompt: 'Capital of Kenya?', options: { A: 'Nairobi', B: 'Kisumu', C: 'Mombasa', D: 'Nakuru' } };
  assert.equal(correctLetterFor(key, shown), 'A');
  assert.equal(correctLetterFor(key, { prompt: 'Something else', options: shown.options }), null);
});

test('summarizeLiveBots: totals, accuracy and late share', () => {
  const bot = (results, reconnects = 0) => ({ results: new Map(results.map((r, i) => [i + 1, r])), reconnects });
  const summary = summarizeLiveBots([bot(['correct', 'correct', 'wrong', 'late'], 2), bot(['correct', 'none', 'wrong', 'correct'])]);
  assert.deepEqual(summary, {
    players: 2,
    correct: 4,
    wrong: 2,
    late: 1,
    none: 1,
    reconnects: 2,
    accuracyPct: 67, // 4 right out of 6 counted
    latePct: 14.3, // 1 late out of 7 sent
  });
});

test('session cookie: express-session itself accepts it and loads the session', async () => {
  const secret = 'a-test-secret';
  const sid = 'bot-session-id_123';

  // Configured like src/auth/session.js, with an in-memory store.
  const store = new session.MemoryStore();
  await new Promise((resolve, reject) => store.set(sid, sessionData(42), (err) => (err ? reject(err) : resolve())));
  const app = express();
  app.use(session({ name: SESSION_COOKIE_NAME, secret, store, resave: false, saveUninitialized: false }));
  app.get('/whoami', (req, res) => res.json({ userId: req.session.userId ?? null, sid: req.sessionID }));

  const server = http.createServer(app).listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/whoami`;

    const good = await (await fetch(url, { headers: { cookie: sessionCookieHeader(sid, secret) } })).json();
    assert.deepEqual(good, { userId: '42', sid });

    // Signed with a different secret: express-session ignores the cookie.
    const forged = await (await fetch(url, { headers: { cookie: sessionCookieHeader(sid, 'wrong-secret') } })).json();
    assert.equal(forged.userId, null);
  } finally {
    server.close();
  }
});

test('sessionData: the shape express-session stores', () => {
  const data = sessionData(7, Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(data.userId, '7');
  assert.deepEqual(Object.keys(data.cookie).sort(), ['expires', 'httpOnly', 'originalMaxAge', 'path', 'sameSite', 'secure']);
  assert.equal(new Date(data.cookie.expires).getTime(), Date.parse('2026-01-01T00:00:00Z') + data.cookie.originalMaxAge);
});
