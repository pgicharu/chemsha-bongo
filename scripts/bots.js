#!/usr/bin/env node
// Bot players from the command line (see src/bots/).
//
//   npm run bots -- --code 123456 [--count 15]   join a live game (max 50 bots)
//   npm run bots -- --quiz <slug> [--count 5]    take a self-paced quiz
//   npm run bots -- --auto-host [--count 15]     host games with bots in a loop
//
// Needs the app's DATABASE_URL and SESSION_SECRET (bots create their own
// sessions), so run it where the app runs, e.g. `docker compose exec app npm run bots -- ...`.
// BOTS_URL is the app to play against (default http://localhost:3000).

import { parseArgs } from 'node:util';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { MAX_BOTS, joinLiveGame, summarizeLiveBots, runSelfPacedBots, runAutoHost, describeError } from '../src/bots/index.js';

const USAGE = `Usage:
  npm run bots -- --code 123456 [--count 15]   join a live game (default 15 bots, max ${MAX_BOTS})
  npm run bots -- --quiz <slug> [--count 5]    take a self-paced quiz (default 5 bots)
  npm run bots -- --auto-host [--count 15]     host games with bots, forever (Ctrl+C stops)
Plays against BOTS_URL (now ${config.bots.url}).`;

const log = {
  info: (message) => console.log(`${new Date().toISOString()}  ${message}`),
  warn: (message) => console.warn(`${new Date().toISOString()}  WARNING ${message}`),
};

function fail(message) {
  console.error(`bots: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseCount(value, fallback) {
  if (value === undefined) return fallback;
  const count = Number.parseInt(value, 10);
  if (!(count >= 1 && count <= MAX_BOTS)) fail(`--count must be a number from 1 to ${MAX_BOTS}`);
  return count;
}

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      code: { type: 'string' },
      quiz: { type: 'string' },
      'auto-host': { type: 'boolean' },
      count: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  fail(err.message);
}
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const baseUrl = config.bots.url;
const modes = ['code', 'quiz', 'auto-host'].filter((name) => options[name] !== undefined);
if (modes.length !== 1) fail('Choose one of --code, --quiz or --auto-host.');

// First signal stops cleanly; a second quits at once.
const stopping = new AbortController();
let onStop = () => {};
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping.signal.aborted) process.exit(1);
    log.info(`${signal}: stopping (press Ctrl+C again to quit at once)`);
    stopping.abort();
    onStop();
  });
}

async function joinGame() {
  const code = String(options.code).trim();
  if (!/^\d{6}$/.test(code)) fail('--code must be the 6-digit game code');
  const count = parseCount(options.count, 15);

  log.info(`Sending ${count} bots into game ${code} at ${baseUrl}`);
  const group = await joinLiveGame({ baseUrl, code, count, log });
  onStop = group.stop;
  // Stopped while the bots were still joining.
  if (stopping.signal.aborted) group.stop();
  log.info(`${group.bots.filter((b) => b.joined).length} bots are in. They play until the game ends (Ctrl+C to stop them).`);
  await group.done;

  const s = summarizeLiveBots(group.bots);
  log.info(
    `Done. ${s.players} bots: ${s.correct} right, ${s.wrong} wrong (${s.accuracyPct}% right), ` +
      `${s.late} late (${s.latePct}%), ${s.none} unanswered, ${s.reconnects} reconnects`,
  );
}

async function takeQuiz() {
  const slug = String(options.quiz).trim();
  const count = parseCount(options.count, 5);
  log.info(`${count} bots are taking self-paced quiz ${slug} at ${baseUrl} (in real time: a few minutes)`);
  const totals = await runSelfPacedBots({ baseUrl, slug, count, log, signal: stopping.signal });
  if (totals.bots === 0 && !stopping.signal.aborted) log.warn('No bot took the quiz (have they all taken it already?)');
  log.info(`Done. ${totals.bots} bots: ${totals.correct} right, ${totals.wrong} wrong, ${totals.late} late, ${totals.none} unanswered`);
}

async function autoHost() {
  const count = parseCount(options.count, 15);
  await runAutoHost({ baseUrl, count, log, signal: stopping.signal });
  log.info('Auto-host stopped.');
}

const run = { code: joinGame, quiz: takeQuiz, 'auto-host': autoHost }[modes[0]];
try {
  await run();
} catch (err) {
  log.warn(describeError(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
// Pending timers (e.g. reconnects) must not keep the process alive.
process.exit();
