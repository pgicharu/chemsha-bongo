// A bot in a live game: its own Socket.IO connection and session, speaking the
// protocol in src/game/sockets.js. Re-sends player:join on every (re)connect;
// the server's `answered` field prevents answering a question twice.

import { setTimeout as sleep } from 'node:timers/promises';
import { io } from 'socket.io-client';
import { planAnswer, chooseOption, correctLetterFor, randomMs } from './behaviour.js';
import { ensureBotPlayers, shuffled } from './accounts.js';
import { createBotSession, deleteBotSessions } from './sessions.js';
import { liveAnswerKey } from './answer-key.js';

export const ACK_TIMEOUT_MS = 10_000;

export const quietLog = { info() {}, warn() {} };

export function warningsOnly(log) {
  return { info() {}, warn: log.warn };
}

// forceNew: otherwise io() calls to the same address share one connection.
export function connectAs(baseUrl, cookie) {
  return io(baseUrl, {
    forceNew: true,
    extraHeaders: { cookie },
    reconnectionDelayMax: 3000, // matches web/js/game/common.js
  });
}

class LiveBot {
  constructor({ baseUrl, account, cookie, answerKey, log = quietLog }) {
    this.baseUrl = baseUrl;
    this.account = account; // { id, name }
    this.cookie = cookie;
    this.answerKey = answerKey;
    this.log = log;

    this.socket = null;
    this.joined = false; // joined at least once
    this.connects = 0;
    this.done = false;
    this.timers = new Set(); // pending answers
    this.planned = new Set();
    this.results = new Map(); // questionNo -> 'correct' | 'wrong' | 'late' | 'none'
    this.finalResult = null; // { score, rank, correctCount, total }
    // Settles once the bot is in the game, or has given up.
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });
  }

  get name() {
    return this.account.name;
  }

  get reconnects() {
    return Math.max(0, this.connects - 1);
  }

  // Resolves with the final result, or null if the game went away or the bot
  // was stopped. Rejects only if the first join fails.
  play(code) {
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject };

      const socket = connectAs(this.baseUrl, this.cookie);
      this.socket = socket;

      socket.on('connect', () => this.join(code));
      socket.on('connect_error', (err) => {
        // Inactive means the server refused the connection; otherwise Socket.IO retries.
        if (!socket.active) this.finish(new Error(`${this.name} could not connect: ${err.message}`));
      });
      socket.on('disconnect', (reason) => {
        // Inactive after a server-side disconnect: no automatic reconnect follows.
        if (!socket.active) this.finish(null);
        else this.log.info(`${this.name} lost the connection (${reason}); reconnecting`);
      });

      socket.on('question:show', (question) => this.onQuestion(question));
      socket.on('answer:result', ({ questionNo, result }) => {
        // A late answer is acknowledged after the reveal's 'none': keep 'late'.
        if (this.results.get(questionNo) !== 'late') this.results.set(questionNo, result);
      });
      socket.on('game:finished', ({ you }) => {
        this.finalResult = you ?? null;
        this.finish(this.finalResult);
      });
    });
  }

  async join(code) {
    this.connects += 1;
    if (this.connects > 1) this.log.info(`${this.name} reconnected; joining again`);

    let reply;
    try {
      reply = await this.socket.timeout(ACK_TIMEOUT_MS).emitWithAck('player:join', { code });
    } catch {
      return; // the next connect retries
    }
    if (reply.ok) {
      if (!this.joined) this.log.info(`${this.name} joined game ${code}`);
      this.joined = true;
      this.markReady();
      return;
    }
    // Refused on a re-join means the game is gone (e.g. the app restarted).
    this.finish(this.joined ? null : new Error(`${this.name} could not join: ${reply.error}`));
  }

  onQuestion(question) {
    const { questionNo } = question;
    if (this.planned.has(questionNo)) return;
    this.planned.add(questionNo);
    if (question.answered) return; // answered before a reconnect

    const plan = planAnswer({ remainingMs: question.remainingMs });
    if (plan.kind === 'skip') return;

    const option = chooseOption({ correctLetter: correctLetterFor(this.answerKey, question), correct: plan.correct });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.answer(questionNo, option);
    }, plan.delayMs);
    this.timers.add(timer);
  }

  async answer(questionNo, option, tries = 1) {
    if (this.done) return;
    let reply;
    try {
      // While disconnected, Socket.IO buffers the event (it may then arrive late).
      reply = await this.socket.timeout(ACK_TIMEOUT_MS).emitWithAck('player:answer', { questionNo, option });
    } catch {
      this.log.warn(`${this.name}: no reply to the answer for question ${questionNo}`);
      return;
    }
    if (reply.ok) {
      if (reply.result === 'late') this.results.set(questionNo, 'late');
      return;
    }
    // Just reconnected and the answer overtook player:join: retry shortly.
    if (reply.code === 'not_joined' && tries < 3) {
      await sleep(500);
      return this.answer(questionNo, option, tries + 1);
    }
    this.log.warn(`${this.name}: answer to question ${questionNo} refused: ${reply.error}`);
  }

  stop() {
    this.finish(null);
  }

  finish(outcome) {
    if (this.done) return;
    this.done = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.socket?.disconnect();
    this.markReady();
    if (outcome instanceof Error) this.settle.reject(outcome);
    else this.settle.resolve(outcome);
  }
}

// Resolves once every bot is in the lobby (or has given up) with
// { bots, done, stop }. excludeUserIds: bots already in the game.
export async function joinLiveGame({ baseUrl, code, count, excludeUserIds = new Set(), log = quietLog }) {
  const answerKey = await liveAnswerKey(code);
  if (answerKey.length === 0) throw new Error(`There is no open game with code ${code}`);

  const accounts = shuffled((await ensureBotPlayers()).filter((a) => !excludeUserIds.has(String(a.id)))).slice(0, count);
  const sessions = await Promise.all(accounts.map((account) => createBotSession(account.id)));
  const bots = accounts.map((account, i) => new LiveBot({ baseUrl, account, cookie: sessions[i].cookie, answerKey, log }));

  const playing = [];
  for (const bot of bots) {
    // Catch here: an unhandled rejection would crash the app (bots can run in-process).
    playing.push(
      bot.play(code).catch((err) => {
        log.warn(err.message);
        return null;
      }),
    );
    await sleep(randomMs(30, 120));
  }

  await Promise.race([Promise.all(bots.map((bot) => bot.ready)), sleep(15_000)]);

  // `done` never rejects: callers may not await it, and an unhandled rejection
  // would crash the app. Sessions left behind expire on their own.
  const done = Promise.all(playing).then(() =>
    deleteBotSessions(sessions.map((s) => s.sid)).catch((err) => log.warn(`Could not delete the bots' sessions: ${err.message}`)),
  );
  return {
    bots,
    done,
    stop: () => bots.forEach((bot) => bot.stop()),
  };
}

// accuracyPct is over correct + wrong; latePct is over correct + wrong + late.
export function summarizeLiveBots(bots) {
  const totals = { players: bots.length, correct: 0, wrong: 0, late: 0, none: 0, reconnects: 0 };
  for (const bot of bots) {
    totals.reconnects += bot.reconnects;
    for (const result of bot.results.values()) {
      if (result in totals) totals[result] += 1;
    }
  }
  const counted = totals.correct + totals.wrong;
  const sent = counted + totals.late;
  totals.accuracyPct = counted ? Math.round((100 * totals.correct) / counted) : 0;
  totals.latePct = sent ? Math.round((1000 * totals.late) / sent) / 10 : 0;
  return totals;
}
