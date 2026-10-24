// Tests for races and stuck states in the live game engine (src/game/engine.js).
// db.js `pool` is replaced with a fake that records every statement and can be told to fail.

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Required by config.js; the real pool never connects.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:1/test';
process.env.SESSION_SECRET ??= 'test';
process.env.LOG_LEVEL ??= 'silent';

const { pool } = await import('../src/db.js');
const engine = await import('../src/game/engine.js');

const db = {
  statements: [], // every SQL text run, in order
  failWhen: null, // (sql) => true to make that statement throw
};

let nextId = 1;
async function fakeQuery(text) {
  const sql = text.replace(/\s+/g, ' ').trim();
  db.statements.push(sql);
  // Yield like a real round trip so other work can interleave.
  await new Promise((resolve) => setImmediate(resolve));
  if (db.failWhen?.(sql)) throw new Error('database unavailable (fake)');
  if (sql.startsWith('INSERT INTO games')) return { rows: [{ id: String(nextId++), code: '123456', created_at: new Date() }] };
  if (sql.startsWith('INSERT INTO attempts')) return { rows: [{ id: String(nextId++) }] };
  return { rows: [], rowCount: 0 };
}

pool.query = fakeQuery;
pool.connect = async () => ({ query: fakeQuery, release() {} });

beforeEach(() => {
  db.statements = [];
  db.failWhen = null;
});

const QUESTION = {
  id: '100',
  prompt: 'Who scrapes /metrics?',
  option_a: 'Prometheus',
  option_b: 'Loki',
  option_c: 'Tempo',
  option_d: 'Grafana',
  correct_option: 'A',
  time_limit_seconds: 20,
};

let userId = 1000;

// Each test needs its own code: the engine allows one open game per code.
async function gameWithOnePlayer(questionCount = 2) {
  const questions = Array.from({ length: questionCount }, (_, i) => ({ ...QUESTION, id: String(100 + i) }));
  const game = await engine.createGame({ quiz: { id: '1', title: 'Test quiz' }, questions, hostId: String(userId++) });
  await engine.joinGame(game, { id: String(userId++), name: 'Amina', avatar: {} });
  return game;
}

// Ends a game so its question timer does not keep the test process alive.
async function cleanUp(game) {
  db.failWhen = null;
  await engine.finishGame(game, 'ended_by_host');
}

test('a double-tapped Start shows question 1 once', async () => {
  const game = await gameWithOnePlayer();
  const [first, second] = await Promise.allSettled([engine.startGame(game), engine.startGame(game)]);

  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.code, 'already_started');
  assert.equal(game.rounds.length, 1);
  assert.equal(game.phase, 'question');
  await cleanUp(game);
});

test('Start fails cleanly, and can be pressed again, if the database is down', async () => {
  const game = await gameWithOnePlayer();
  db.failWhen = (sql) => sql.startsWith('UPDATE games SET status = \'running\'');
  await assert.rejects(engine.startGame(game), /database unavailable/);
  assert.equal(game.phase, 'lobby');

  db.failWhen = null;
  await engine.startGame(game);
  assert.equal(game.phase, 'question');
  await cleanUp(game);
});

test('Start and Next do nothing once the host has pressed End', async () => {
  const lobbyGame = await gameWithOnePlayer();
  const ending = engine.finishGame(lobbyGame, 'ended_by_host');
  await assert.rejects(engine.startGame(lobbyGame), { code: 'finished' });
  await ending;
  assert.equal(lobbyGame.rounds.length, 0);
  assert.equal(lobbyGame.phase, 'finished');

  const game = await gameWithOnePlayer(3);
  await engine.startGame(game);
  await engine.nextStep(game);
  await engine.nextStep(game);
  assert.equal(game.phase, 'leaderboard');
  const ending2 = engine.finishGame(game, 'ended_by_host');
  await assert.rejects(engine.nextStep(game), { code: 'finished' });
  await ending2;
  assert.equal(game.rounds.length, 1);
  assert.equal(game.phase, 'finished');
});

test('nobody can join a game while it is ending', async () => {
  const game = await gameWithOnePlayer();
  const ending = engine.finishGame(game, 'ended_by_host');
  await assert.rejects(engine.joinGame(game, { id: String(userId++), name: 'Late', avatar: {} }), { code: 'finished' });
  await ending;
});

test('a question that failed to close can be closed again by Next', async () => {
  const game = await gameWithOnePlayer();
  await engine.startGame(game);

  db.failWhen = (sql) => sql.includes("'none'");
  await assert.rejects(engine.nextStep(game), /database unavailable/);
  assert.equal(game.phase, 'question');

  db.failWhen = null;
  db.statements = [];
  await engine.nextStep(game);
  assert.equal(game.phase, 'reveal');
  assert.ok(
    db.statements.some((sql) => sql.includes("'none'")),
    "the retry saves the 'none' rows the failed close could not",
  );
  await cleanUp(game);
});

test('End still finishes a game whose current question could not be closed', async () => {
  const game = await gameWithOnePlayer();
  await engine.startGame(game);
  db.failWhen = (sql) => sql.includes("'none'");

  await engine.finishGame(game, 'ended_by_host');
  assert.equal(game.phase, 'finished');
  assert.ok(db.statements.some((sql) => sql.startsWith("UPDATE games SET status = 'finished'")));
});

test('a game whose host never opens it is ended after the host-away limit', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const game = await gameWithOnePlayer();
    assert.equal(game.phase, 'lobby');
    mock.timers.tick(15 * 60 * 1000);
    // finishGame runs in the timer; let its (fake) queries complete.
    for (let i = 0; i < 20 && game.phase !== 'finished'; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(game.phase, 'finished');
  } finally {
    mock.timers.reset();
  }
});

test('opening the game as host stops the host-away timer', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const game = await gameWithOnePlayer();
    engine.hostConnected(game, 'socket-1');
    mock.timers.tick(15 * 60 * 1000);
    await new Promise((r) => setImmediate(r));
    assert.equal(game.phase, 'lobby');
    await cleanUp(game);
  } finally {
    mock.timers.reset();
  }
});
