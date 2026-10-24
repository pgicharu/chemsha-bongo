// Auto-host: a bot host that runs live games in a loop (with bot players, and
// an occasional self-paced round) to generate steady traffic for the dashboards.
// On abort, a game in progress is ended with host:end rather than left to be abandoned.

import { setTimeout as sleep } from 'node:timers/promises';
import { randomMs } from './behaviour.js';
import { ensureBotHost, ensureBotPlayers } from './accounts.js';
import { createBotSession, deleteBotSessions } from './sessions.js';
import { ACK_TIMEOUT_MS, connectAs, joinLiveGame, summarizeLiveBots, quietLog, warningsOnly } from './live-player.js';
import { runSelfPacedBots } from './self-paced.js';
import { ensureLiveQuiz, ensureSelfPacedQuiz } from './seed-quiz.js';
import { apiRequest, apiError, describeError } from './http.js';

const LOBBY_WAIT_MS = 30_000;
// A game with no events for this long is ended and the next cycle starts.
const STUCK_AFTER_MS = 90_000;
// Every N live games, a self-paced round with [min, max] bots.
const SELF_PACED_EVERY = 3;
const SELF_PACED_BOTS = [3, 5];

function minutesSeconds(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

async function hostOneGame({ baseUrl, hostCookie, quizId, count, label = 'Game', log = quietLog, signal }) {
  const created = await apiRequest(baseUrl, hostCookie, 'POST', '/api/games', { quizId });
  if (!created.ok) throw apiError('Creating a game', created);
  const { gameId, code } = created.data;
  const startedAt = Date.now();
  log.info(`${label}: created game ${gameId}, code ${code}`);

  const socket = connectAs(baseUrl, hostCookie);
  const send = (event, payload = {}) =>
    socket
      .timeout(ACK_TIMEOUT_MS)
      .emitWithAck(event, payload)
      .catch(() => ({ ok: false, error: 'no reply from the server', code: 'no_reply' }));

  let lobbyCount = 0;
  let lastEventAt = Date.now();
  let gone = false; // the server no longer knows this game (e.g. it restarted)
  const acted = new Set(); // screens already advanced: 'reveal:3', 'board:3'
  const shown = new Set();
  const nextTimers = new Set();
  let players = null;
  let resolveOpened;
  const opened = new Promise((resolve) => {
    resolveOpened = resolve;
  });
  const finished = new Promise((resolve) => socket.on('game:finished', resolve));

  // Sent on every connect, including reconnects, like the host page.
  socket.on('connect', async () => {
    const reply = await send('host:open', { gameId });
    if (reply.ok) return resolveOpened();
    if (reply.code === 'not_found') gone = true;
    log.warn(`${label}: host:open refused: ${reply.error}`);
  });
  socket.onAny(() => {
    lastEventAt = Date.now();
  });
  socket.on('lobby:update', ({ count: n }) => {
    lobbyCount = n;
  });
  socket.on('question:show', ({ questionNo, total }) => {
    if (shown.has(questionNo)) return;
    shown.add(questionNo);
    log.info(`${label}: question ${questionNo} of ${total}`);
  });

  // Once per screen, so a screen re-sent after a reconnect is not advanced twice.
  function nextAfter(screenKey, pauseMs) {
    if (acted.has(screenKey)) return;
    acted.add(screenKey);
    const timer = setTimeout(async () => {
      nextTimers.delete(timer);
      if (signal?.aborted) return;
      const reply = await send('host:next');
      if (reply.ok) return;
      log.warn(`${label}: host:next refused: ${reply.error}`);
      // Lost in a disconnect: retry when the screen is re-sent after reconnecting.
      if (reply.code === 'no_reply') acted.delete(screenKey);
    }, pauseMs);
    nextTimers.add(timer);
  }
  socket.on('question:reveal', ({ questionNo }) => nextAfter(`reveal:${questionNo}`, randomMs(4000, 6000)));
  socket.on('leaderboard:show', ({ questionNo }) => nextAfter(`board:${questionNo}`, randomMs(3000, 5000)));

  const endNow = () => send('host:end');
  signal?.addEventListener('abort', endNow, { once: true });

  try {
    await Promise.race([opened, sleep(15_000).then(() => Promise.reject(new Error('could not open the game as host')))]);

    players = await joinLiveGame({ baseUrl, code, count, log: warningsOnly(log) });
    const lobbyDeadline = Date.now() + LOBBY_WAIT_MS;
    while (lobbyCount < count && Date.now() < lobbyDeadline && !signal?.aborted) await sleep(250);
    if (signal?.aborted) throw new Error('stopped');
    if (lobbyCount === 0) throw new Error('no bot could join');
    log.info(`${label}: ${lobbyCount} players in the lobby; starting`);
    await sleep(randomMs(2000, 4000));

    const started = await send('host:start');
    if (!started.ok) throw new Error(`host:start refused: ${started.error}`);

    for (;;) {
      const tick = sleep(5000).then(() => 'tick');
      if ((await Promise.race([finished, tick])) !== 'tick') break;
      // host:end was already sent on abort; don't wait if the app is down.
      if (signal?.aborted) break;
      if (gone) throw new Error('the server no longer has this game (did the app restart?)');
      if (Date.now() - lastEventAt > STUCK_AFTER_MS) {
        log.warn(`${label}: nothing happened for ${STUCK_AFTER_MS / 1000} s; ending the game`);
        await endNow();
        await Promise.race([finished, sleep(10_000)]);
        break;
      }
    }
  } catch (err) {
    if (!gone) await endNow();
    throw err;
  } finally {
    signal?.removeEventListener('abort', endNow);
    for (const timer of nextTimers) clearTimeout(timer);
    if (players) {
      if (!signal?.aborted) await Promise.race([players.done, sleep(10_000)]);
      players.stop();
      await players.done;
    }
    socket.disconnect();
  }

  const summary = summarizeLiveBots(players.bots);
  log.info(
    `${label}: finished in ${minutesSeconds(Date.now() - startedAt)}. ${summary.players} bots, ` +
      `${summary.accuracyPct}% right, ${summary.late} late (${summary.latePct}%), ` +
      `${summary.none} unanswered, ${summary.reconnects} reconnects`,
  );
  return summary;
}

async function selfPacedRound({ baseUrl, host, hostCookie, log, signal }) {
  const count = randomMs(...SELF_PACED_BOTS);
  const botCount = (await ensureBotPlayers()).length;
  const slug = await ensureSelfPacedQuiz({ baseUrl, host, hostCookie, botsNeeded: count, botCount });
  log.info(`Self-paced: ${count} bots are taking quiz ${slug}`);
  const totals = await runSelfPacedBots({ baseUrl, slug, count, log: warningsOnly(log), signal });
  log.info(
    `Self-paced: ${totals.bots} bots finished ${slug}: ${totals.correct} right, ${totals.wrong} wrong, ` +
      `${totals.late} late, ${totals.none} unanswered`,
  );
}

async function waitForApp(baseUrl, log, signal) {
  for (let tries = 0; !signal?.aborted; tries += 1) {
    try {
      if ((await fetch(new URL('/health', baseUrl))).ok) return;
    } catch {
      // not up yet
    }
    if (tries === 0) log.info(`Waiting for the app at ${baseUrl} ...`);
    await sleep(2000, undefined, { signal }).catch(() => {});
  }
}

// Resolves once `signal` is aborted and the current game has been ended.
export async function runAutoHost({ baseUrl, count, log = quietLog, signal }) {
  const host = await ensureBotHost();
  await ensureBotPlayers();
  const { sid, cookie: hostCookie } = await createBotSession(host.id);
  let selfPaced = null; // background self-paced round, if any

  try {
    await waitForApp(baseUrl, log, signal);
    if (signal?.aborted) return;
    const quizId = await ensureLiveQuiz({ baseUrl, host, hostCookie });
    log.info(`Auto-host: ${host.name} hosts "Observability warm-up" (quiz ${quizId}) with ${count} bots at ${baseUrl}`);

    for (let gameNo = 1; !signal?.aborted; gameNo += 1) {
      try {
        await hostOneGame({ baseUrl, hostCookie, quizId, count, label: `Game #${gameNo}`, log, signal });
      } catch (err) {
        if (signal?.aborted) break;
        log.warn(`Game #${gameNo} did not complete: ${describeError(err)}`);
        await waitForApp(baseUrl, log, signal);
      }

      if (gameNo % SELF_PACED_EVERY === 0 && !selfPaced && !signal?.aborted) {
        selfPaced = selfPacedRound({ baseUrl, host, hostCookie, log, signal })
          .catch((err) => log.warn(`Self-paced round failed: ${err.message}`))
          .finally(() => {
            selfPaced = null;
          });
      }

      const pauseMs = randomMs(20_000, 40_000);
      if (!signal?.aborted) log.info(`Next game in ${Math.round(pauseMs / 1000)} s`);
      await sleep(pauseMs, undefined, { signal }).catch(() => {});
    }
    await selfPaced;
  } finally {
    await deleteBotSessions([sid]);
  }
}
