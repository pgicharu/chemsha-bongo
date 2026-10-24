// Live game engine. Running games live in memory (lost on restart); Postgres
// holds the record (games, attempts, answers, ranks).
//
// Phases: lobby → question → reveal → leaderboard → question ... ; the last
// reveal goes to finished, and host:end finishes from any phase.
//
// Timer callbacks (question close, host-away finish) start root spans so they
// do not appear inside the trace of the request that set the timer.

import { randomInt } from 'node:crypto';
import { query, transaction } from '../db.js';
import { logger } from '../logger.js';
import { inSpan } from '../spans.js';
import { answersTotal, answerScoringSeconds, setGameStateReader } from '../metrics.js';
import { isOn as chaosIsOn } from '../chaos/switches.js';
import { LATE_GRACE_MS, deadlineAtMs, isLate, judgeAnswer, rankByScore } from './scoring.js';
import { isCached, rememberLeaderboard } from './leaderboard-cache.js';

export const MAX_PLAYERS = 50;

// A game whose host screen stays disconnected this long is ended.
const HOST_AWAY_LIMIT_MS = 15 * 60 * 1000;

// Kept in memory after finishing so late reconnects still see the results.
const FINISHED_GAME_KEEP_MS = 10 * 60 * 1000;

const TOP_COUNT = 5;

export const OPTIONS = ['A', 'B', 'C', 'D'];

// Message is safe to show to the player; any other error is logged and hidden.
export class GameError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// pg returns bigint ids as strings; ids are kept as strings everywhere and
// compared with String(...) when they may come from elsewhere.
const games = new Map(); // gameId -> game
const gamesByCode = new Map(); // '123456' -> game

let io = null;

// Read at scrape time; "active" excludes finished games.
setGameStateReader(() => {
  const active = [...games.values()].filter((game) => game.phase !== 'finished');
  let playersConnected = 0;
  for (const game of active) {
    for (const player of game.players.values()) playersConnected += player.socketIds.size;
  }
  return { gamesActive: active.length, playersConnected };
});

export function useSocketServer(socketServer) {
  io = socketServer;
}

// Socket.IO rooms. A player room holds all of that player's sockets (tabs).
export const rooms = {
  game: (game) => `game:${game.id}`,
  host: (game) => `game:${game.id}:host`,
  player: (game, userId) => `game:${game.id}:user:${userId}`,
};

export function getGame(gameId) {
  return games.get(String(gameId));
}

// Excludes joins whose attempts row is still being saved (no attemptId yet).
function joinedPlayers(game) {
  return [...game.players.values()].filter((player) => player.attemptId);
}

// Falls back to a recently finished game so late reconnects see the results.
export function getGameByCode(code) {
  const open = gamesByCode.get(code);
  if (open) return open;
  const finished = [...games.values()].filter((g) => g.code === code && g.phase === 'finished');
  return finished.at(-1);
}

// ---------------------------------------------------------------------------
// Creating a game
// ---------------------------------------------------------------------------

// crypto.randomInt so codes cannot be predicted from earlier ones.
function randomCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

// A partial unique index allows one open game per code; retry on a clash.
async function insertGameRow(quizId, hostId) {
  for (let tries = 0; tries < 10; tries += 1) {
    const code = randomCode();
    if (gamesByCode.has(code)) continue;
    try {
      const { rows } = await query(
        `INSERT INTO games (quiz_id, host_id, code) VALUES ($1, $2, $3)
         RETURNING id, code, created_at`,
        [quizId, hostId, code],
      );
      return rows[0];
    } catch (err) {
      if (err.code !== '23505') throw err; // unique_violation
    }
  }
  throw new Error('Could not find a free game code after 10 tries');
}

export async function createGame({ quiz, questions, hostId }) {
  const row = await insertGameRow(quiz.id, hostId);

  const game = {
    id: row.id,
    code: row.code,
    quizId: quiz.id,
    quizTitle: quiz.title,
    hostId: String(hostId),
    questions: questions.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      options: { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d },
      correctOption: q.correct_option,
      timeLimitSeconds: q.time_limit_seconds,
    })),
    status: 'lobby', // games.status: lobby → running → finished
    phase: 'lobby', // lobby | question | reveal | leaderboard | finished
    players: new Map(), // userId -> player
    rounds: [], // one per question shown so far
    hostSocketIds: new Set(),
    hostAwayTimer: null,
    ending: false, // set as soon as finishGame() starts
    createdAtMs: Date.now(),
    startedAtMs: null,
  };
  games.set(game.id, game);
  gamesByCode.set(game.code, game);

  // Covers a host that never opens the game.
  startHostAwayTimer(game);

  logger.info(
    { event: 'game.created', game_id: game.id, quiz_id: game.quizId, host_id: game.hostId, code: game.code, question_count: game.questions.length },
    'Game created',
  );
  return game;
}

// ---------------------------------------------------------------------------
// Joining: players and the host
// ---------------------------------------------------------------------------

function publicPlayer(player) {
  return { id: player.id, name: player.name, avatar: player.avatar };
}

function lobbyPayload(game) {
  const players = joinedPlayers(game).map(publicPlayer);
  return { players, count: players.length };
}

// Also handles re-joins after a reconnect. Returns { player, isNew }.
export async function joinGame(game, user) {
  const userId = String(user.id);
  if (game.ending) {
    // No newcomers; existing players may come back for the results.
    const existing = game.players.get(userId);
    if (existing) return { player: existing, isNew: false };
    throw new GameError('That game has already finished.', 'finished');
  }
  if (userId === game.hostId) {
    throw new GameError("You're hosting this game. To play, join from a different account.", 'is_host');
  }

  const existing = game.players.get(userId);
  if (existing) {
    logger.info({ event: 'player.rejoined', game_id: game.id, player_id: userId, phase: game.phase }, 'Player rejoined');
    return { player: existing, isNew: false };
  }

  if (game.players.size >= MAX_PLAYERS) {
    throw new GameError(`Sorry, this game is full (${MAX_PLAYERS} players). Ask the host to start another one.`, 'full');
  }

  // Added to memory before the await so concurrent joins cannot exceed MAX_PLAYERS.
  const player = {
    id: userId,
    name: user.name,
    avatar: user.avatar ?? {},
    attemptId: null, // set once the attempts row exists
    score: 0,
    correctCount: 0,
    socketIds: new Set(), // empty = offline
  };
  game.players.set(userId, player);

  try {
    // ON CONFLICT: the same player joining from two tabs at once.
    const { rows } = await query(
      `INSERT INTO attempts (user_id, quiz_id, game_id) VALUES ($1, $2, $3)
       ON CONFLICT (game_id, user_id) WHERE game_id IS NOT NULL
       DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING id`,
      [userId, game.quizId, game.id],
    );
    player.attemptId = rows[0].id;
  } catch (err) {
    game.players.delete(userId);
    throw err;
  }

  logger.info(
    { event: 'player.joined', game_id: game.id, player_id: userId, attempt_id: player.attemptId, player_count: game.players.size },
    'Player joined',
  );
  io?.to(rooms.game(game)).emit('lobby:update', lobbyPayload(game));
  return { player, isNew: true };
}

export function playerConnected(game, player, socketId) {
  player.socketIds.add(socketId);
}

export function playerDisconnected(game, player, socketId) {
  player.socketIds.delete(socketId);
  closeQuestionIfEveryoneAnswered(game);
}

export function hostConnected(game, socketId) {
  clearTimeout(game.hostAwayTimer);
  game.hostAwayTimer = null;
  game.hostSocketIds.add(socketId);
}

// The game carries on without the host; it ends only after HOST_AWAY_LIMIT_MS.
export function hostDisconnected(game, socketId) {
  game.hostSocketIds.delete(socketId);
  if (game.hostSocketIds.size > 0 || game.ending) return;

  logger.info({ event: 'host.disconnected', game_id: game.id, phase: game.phase }, 'Host screen disconnected; game continues');
  startHostAwayTimer(game);
}

// hostConnected() clears this timer.
function startHostAwayTimer(game) {
  clearTimeout(game.hostAwayTimer);
  game.hostAwayTimer = setTimeout(() => {
    inSpan('game.finish', { 'game.id': game.id, 'game.end_reason': 'host_left' }, () => finishGame(game, 'host_left'), {
      root: true,
    }).catch((err) => logger.error({ event: 'game.finish_failed', game_id: game.id, err }, 'Could not finish game'));
  }, HOST_AWAY_LIMIT_MS);
  game.hostAwayTimer.unref();
}

// ---------------------------------------------------------------------------
// Running the game
// ---------------------------------------------------------------------------

function refuseIfEnding(game) {
  if (game.ending) throw new GameError('The game has finished.', 'finished');
}

export async function startGame(game) {
  refuseIfEnding(game);
  // `status` changes before the await so a double-tapped Start cannot pass twice.
  if (game.status !== 'lobby') throw new GameError('The game has already started.', 'already_started');
  if (joinedPlayers(game).length === 0) throw new GameError('Wait for at least one player to join.', 'no_players');

  game.status = 'running';
  try {
    await query(`UPDATE games SET status = 'running', started_at = now() WHERE id = $1 AND status = 'lobby'`, [game.id]);
  } catch (err) {
    game.status = 'lobby'; // the host can press Start again
    throw err;
  }
  // The host may have pressed End during the await.
  if (game.ending) return;

  game.startedAtMs = Date.now();
  logger.info({ event: 'game.started', game_id: game.id, player_count: game.players.size, question_count: game.questions.length }, 'Game started');

  showNextQuestion(game);
}

export async function nextStep(game) {
  refuseIfEnding(game);
  switch (game.phase) {
    case 'question':
      return closeQuestion(game, currentRound(game), 'host_skipped');
    case 'reveal':
      if (currentRound(game).questionNo === game.questions.length) {
        return finishGame(game, 'completed');
      }
      game.phase = 'leaderboard';
      cacheLeaderboard(game);
      io?.to(rooms.game(game)).emit('leaderboard:show', leaderboardPayload(game));
      return undefined;
    case 'leaderboard':
      return showNextQuestion(game);
    case 'lobby':
      throw new GameError('Press Start to begin the game.', 'not_started');
    default:
      throw new GameError('The game has finished.', 'finished');
  }
}

function currentRound(game) {
  return game.rounds[game.rounds.length - 1];
}

function showNextQuestion(game) {
  const index = game.rounds.length;
  const question = game.questions[index];
  const shownAtMs = Date.now();
  const timeLimitMs = question.timeLimitSeconds * 1000;

  const round = {
    questionNo: index + 1, // 1-based
    question,
    timeLimitMs,
    shownAtMs,
    deadlineAtMs: deadlineAtMs(shownAtMs, question.timeLimitSeconds),
    answers: new Map(), // userId -> { option, result, points }
    pending: new Set(), // answer saves in flight
    closed: false,
    closing: null, // the closeQuestion() promise, once started
    timer: null,
  };
  game.rounds.push(round);
  game.phase = 'question';

  // Closes after the grace too. Timer lateness is harmless: answers are judged
  // with isLate(), not by this timer.
  closeQuestionAfter(game, round, timeLimitMs + LATE_GRACE_MS, 'time_up');

  logger.info(
    { event: 'question.shown', game_id: game.id, question_no: round.questionNo, time_limit_ms: timeLimitMs },
    'Question shown',
  );
  io?.to(rooms.game(game)).emit('question:show', questionPayload(game, round, null));
  io?.to(rooms.host(game)).emit('question:progress', progressPayload(game, round));
}

function questionPayload(game, round, answeredOption) {
  return {
    questionNo: round.questionNo,
    total: game.questions.length,
    prompt: round.question.prompt,
    options: round.question.options,
    timeLimitSeconds: round.question.timeLimitSeconds,
    // A duration, so client clock skew does not matter.
    remainingMs: Math.max(0, round.deadlineAtMs - Date.now()),
    // The option already chosen (after a reconnect), or null.
    answered: answeredOption,
  };
}

function progressPayload(game, round) {
  return { answered: round.answers.size, total: joinedPlayers(game).length };
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

// receivedAtMs must be read by the caller before any other work.
export async function submitAnswer(game, userId, { questionNo, option }, receivedAtMs) {
  const player = game.players.get(String(userId));
  if (!player?.attemptId) throw new GameError("You're not in this game. Join with the code first.", 'not_joined');
  if (!OPTIONS.includes(option)) throw new GameError('Pick A, B, C or D.', 'bad_option');

  const round = game.rounds[Number(questionNo) - 1];
  if (!round) throw new GameError('That question has not been shown.', 'bad_question');

  // Duplicates are ignored, except that a late answer may replace the 'none'
  // written when the question closed.
  const existing = round.answers.get(player.id);
  if (existing && existing.result !== 'none') {
    return { result: 'duplicate', message: 'You already answered this question.' };
  }

  const late = isLate(receivedAtMs, round.deadlineAtMs);
  if (!late && round.closed) {
    // In time, but closed early (host:next, or everyone online had answered).
    return { result: 'closed', message: 'This question has closed.' };
  }

  // Recorded before any await so a second tap during the save is a duplicate.
  round.answers.set(player.id, { option, result: 'pending', points: 0 });

  const saving = scoreAndSaveAnswer({ game, round, player, option, receivedAtMs });
  round.pending.add(saving);
  let outcome;
  try {
    outcome = await saving;
  } catch (err) {
    // Not saved: restore so the player can retry.
    if (existing) round.answers.set(player.id, existing);
    else round.answers.delete(player.id);
    throw err;
  } finally {
    round.pending.delete(saving);
  }

  if (outcome.result === 'late') {
    return { result: 'late', message: 'Too late!' };
  }

  io?.to(rooms.host(game)).emit('question:progress', progressPayload(game, round));
  closeQuestionIfEveryoneAnswered(game);
  // Right/wrong is only sent at the reveal.
  return { result: 'locked', message: 'Answer locked in' };
}

async function scoreAndSaveAnswer({ game, round, player, option, receivedAtMs }) {
  const outcome = await processAnswer(
    {
      quizId: game.quizId,
      gameId: game.id,
      playerId: player.id,
      attemptId: player.attemptId,
      questionNo: round.questionNo,
      question: {
        id: round.question.id,
        correctOption: round.question.correctOption,
        timeLimitSeconds: round.question.timeLimitSeconds,
      },
      shownAtMs: round.shownAtMs,
      option,
      receivedAtMs,
    },
    { onJudged: ({ result, points }) => round.answers.set(player.id, { option, result, points }) },
  );

  // The in-memory score changes only after the database update succeeds.
  if (outcome.result === 'correct') {
    player.score += outcome.points;
    player.correctCount += 1;
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Answer path shared by live games and self-paced quizzes
// ---------------------------------------------------------------------------

// Judges, saves, counts, traces and logs one answer. gameId is null for
// self-paced attempts. onJudged runs after judging and before saving.
// Ids are fine as span attributes but must never become metric labels.
export async function processAnswer(answer, { onJudged } = {}) {
  const { quizId, gameId, playerId, questionNo, question, shownAtMs, option, receivedAtMs } = answer;
  const deadline = deadlineAtMs(shownAtMs, question.timeLimitSeconds);
  const attributes = gameId
    ? { 'game.id': gameId, 'player.id': playerId, 'question.no': questionNo }
    : { 'quiz.id': quizId, 'player.id': playerId, 'question.no': questionNo };

  return inSpan('answer.process', attributes, async (span) => {
    const { result, points } = await inSpan('answer.score', attributes, async (scoreSpan) => {
      const judged = judgeAnswer({
        option,
        correctOption: question.correctOption,
        shownAtMs,
        timeLimitSeconds: question.timeLimitSeconds,
        receivedAtMs,
      });
      // Fault injection (`slow-scoring` switch): a slow SQL call (~4 s). It does
      // not affect points; the answer was already judged by its received time.
      if (chaosIsOn('slow-scoring')) {
        const { rows } = await query('SELECT player_streak_bonus($1, $2) AS streak', [playerId, quizId]);
        scoreSpan.setAttribute('answer.streak', rows[0].streak);
      }
      return judged;
    });
    span.setAttributes({ 'answer.result': result, 'answer.points': points });
    onJudged?.({ result, points });

    await inSpan('answer.save', attributes, () =>
      saveAnswer({ ...answer, deadlineAtMs: deadline, result, points }),
    );

    answersTotal.labels(result).inc();
    answerScoringSeconds.observe((Date.now() - receivedAtMs) / 1000);
    logAnswer(answer, deadline, { result, points });

    return { result, points };
  });
}

function logAnswer({ quizId, gameId, playerId, questionNo, shownAtMs, receivedAtMs }, deadline, { result, points }) {
  const where = gameId ? { game_id: gameId } : { quiz_id: quizId };
  if (result === 'late') {
    logger.info(
      {
        event: 'answer.late',
        ...where,
        player_id: playerId,
        question_no: questionNo,
        deadline_at: new Date(deadline).toISOString(),
        received_at: new Date(receivedAtMs).toISOString(),
        // Measured from the deadline, not deadline + grace.
        ms_late: receivedAtMs - deadline,
      },
      'Late answer rejected',
    );
  } else {
    logger.info(
      {
        event: 'answer.scored',
        ...where,
        player_id: playerId,
        question_no: questionNo,
        result,
        points,
        latency_ms: receivedAtMs - shownAtMs,
      },
      'Answer scored',
    );
  }
}

async function saveAnswer({ attemptId, question, questionNo, option, result, points, shownAtMs, deadlineAtMs: deadline, receivedAtMs }) {
  await transaction(async (client) => {
    // A late answer replaces the 'none' row written at close, keeping its real arrival time.
    await client.query(
      `INSERT INTO answers
         (attempt_id, question_id, question_no, chosen_option, result, points, shown_at, deadline_at, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (attempt_id, question_id) DO UPDATE
         SET chosen_option = EXCLUDED.chosen_option, result = EXCLUDED.result, received_at = EXCLUDED.received_at
         WHERE answers.result = 'none'`,
      [attemptId, question.id, questionNo, option, result, points, new Date(shownAtMs), new Date(deadline), new Date(receivedAtMs)],
    );
    if (result === 'correct') {
      await client.query(
        `UPDATE attempts SET score = score + $1, correct_count = correct_count + 1 WHERE id = $2`,
        [points, attemptId],
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Closing a question and the reveal
// ---------------------------------------------------------------------------

// With nobody online, waits for the timer rather than closing on an empty room.
function closeQuestionIfEveryoneAnswered(game) {
  if (game.phase !== 'question') return;
  const round = currentRound(game);
  if (round.closed) return;

  const online = joinedPlayers(game).filter((p) => p.socketIds.size > 0);
  if (online.length > 0 && online.every((p) => round.answers.has(p.id))) {
    closeQuestionAfter(game, round, 0, 'all_answered');
  }
}

// Automatic closes (time up, all answered) go through here to get their own
// root trace; host:next closes directly inside the host's trace.
function closeQuestionAfter(game, round, delayMs, reason) {
  clearTimeout(round.timer);
  round.timer = setTimeout(() => {
    // Fault injection (`crash` switch): an intentional off-by-one that reads a
    // round that does not exist yet, so the next line throws an uncaught
    // TypeError and the process exits.
    const target = chaosIsOn('crash') ? game.rounds[round.questionNo] : round;
    if (target.closing) return;

    const attributes = { 'game.id': game.id, 'question.no': round.questionNo, 'question.close_reason': reason };
    inSpan('question.close', attributes, () => closeQuestion(game, round, reason), { root: true }).catch((err) =>
      logger.error({ event: 'question.close_failed', game_id: game.id, question_no: round.questionNo, err }, 'Could not close question'),
    );
  }, delayMs);
}

// Idempotent: a second call waits for the first. On failure the question stays
// closed but unrevealed, and host:next or host:end retries.
function closeQuestion(game, round, reason) {
  if (!round.closing) {
    round.closing = doCloseQuestion(game, round, reason).catch((err) => {
      round.closing = null; // allow a retry
      throw err;
    });
  }
  return round.closing;
}

async function doCloseQuestion(game, round, reason) {
  round.closed = true;
  clearTimeout(round.timer);

  // In-time answers still being saved count.
  await Promise.allSettled([...round.pending]);

  const answered = round.answers.size;
  const missing = joinedPlayers(game).filter((p) => !round.answers.has(p.id));
  await saveNoAnswers(round, missing);
  // Recorded only after saving so a retry saves them again; skip late answers
  // that arrived meanwhile.
  for (const player of missing) {
    if (!round.answers.has(player.id)) round.answers.set(player.id, { option: null, result: 'none', points: 0 });
  }

  logger.info(
    { event: 'question.closed', game_id: game.id, question_no: round.questionNo, reason, answered, no_answer: missing.length },
    'Question closed',
  );

  // host:end during the close: finishGame() takes over.
  if (game.ending) return;

  game.phase = 'reveal';
  cacheLeaderboard(game);
  io?.to(rooms.game(game)).emit('question:reveal', revealPayload(game, round));
  const ranks = currentRanks(game);
  for (const player of game.players.values()) {
    io?.to(rooms.player(game, player.id)).emit('answer:result', answerResultPayload(game, round, player, ranks));
  }
}

async function saveNoAnswers(round, players) {
  if (players.length === 0) return;
  await query(
    `INSERT INTO answers (attempt_id, question_id, question_no, result, points, shown_at, deadline_at)
     SELECT attempt_id, $2, $3, 'none', 0, $4, $5 FROM unnest($1::bigint[]) AS attempt_id
     ON CONFLICT (attempt_id, question_id) DO NOTHING`,
    [players.map((p) => p.attemptId), round.question.id, round.questionNo, new Date(round.shownAtMs), new Date(round.deadlineAtMs)],
  );
}

function revealPayload(game, round) {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const answer of round.answers.values()) {
    // Late and missing answers are not counted.
    if (answer.result === 'correct' || answer.result === 'wrong') counts[answer.option] += 1;
  }
  return {
    questionNo: round.questionNo,
    total: game.questions.length,
    // Repeated so a screen reconnecting during the reveal can draw it.
    prompt: round.question.prompt,
    options: round.question.options,
    correctOption: round.question.correctOption,
    counts,
  };
}

function answerResultPayload(game, round, player, ranks) {
  const answer = round.answers.get(player.id) ?? { result: 'none', points: 0, option: null };
  return {
    questionNo: round.questionNo,
    result: answer.result,
    option: answer.option,
    correctOption: round.question.correctOption,
    points: answer.points,
    totalScore: player.score,
    rank: ranks.get(player.id),
    playerCount: ranks.size,
  };
}

// ---------------------------------------------------------------------------
// Leaderboard and the end of the game
// ---------------------------------------------------------------------------

function rankedPlayers(game) {
  return rankByScore(joinedPlayers(game));
}

function currentRanks(game) {
  return new Map(rankedPlayers(game).map((p) => [p.id, p.rank]));
}

function topPlayers(game) {
  return rankedPlayers(game)
    .slice(0, TOP_COUNT)
    .map((p) => ({ name: p.name, avatar: p.avatar, score: p.score, rank: p.rank }));
}

function leaderboardPayload(game) {
  const round = currentRound(game);
  return { questionNo: round.questionNo, total: game.questions.length, top: topPlayers(game) };
}

// Fault injection (`leaderboard-leak` switch): see leaderboard-cache.js.
function cacheLeaderboard(game) {
  if (!chaosIsOn('leaderboard-leak')) return;
  const { questionNo } = currentRound(game);
  if (!isCached(game, questionNo)) rememberLeaderboard(game, questionNo, rankedPlayers(game));
}

function finishedPayload(game, player, ranks) {
  const payload = { top5: topPlayers(game), playerCount: ranks.size, quizTitle: game.quizTitle };
  if (player) {
    payload.you = { score: player.score, rank: ranks.get(player.id), correctCount: player.correctCount, total: game.questions.length };
  }
  return payload;
}

export async function finishGame(game, reason) {
  if (game.ending) return;
  game.ending = true;
  clearTimeout(game.hostAwayTimer);

  // Save failures are logged; the game still ends and everyone gets results.
  try {
    // Closes a question in progress (writing 'none' rows) without revealing it.
    const round = currentRound(game);
    if (round) await closeQuestion(game, round, 'game_ended');
  } catch (err) {
    logger.error({ event: 'question.close_failed', game_id: game.id, question_no: game.rounds.length, err }, 'Could not close question');
  }

  const ranked = rankedPlayers(game);
  try {
    await saveFinalRanks(game, ranked);
  } catch (err) {
    logger.error({ event: 'game.finish_failed', game_id: game.id, err }, 'Could not save the end of the game');
  }

  game.status = 'finished';
  game.phase = 'finished';
  logger.info(
    {
      event: 'game.finished',
      game_id: game.id,
      reason, // completed | ended_by_host | host_left
      player_count: ranked.length,
      questions_played: game.rounds.length,
      duration_ms: Date.now() - (game.startedAtMs ?? game.createdAtMs),
    },
    'Game finished',
  );

  const ranks = new Map(ranked.map((p) => [p.id, p.rank]));
  io?.to(rooms.host(game)).emit('game:finished', finishedPayload(game, null, ranks));
  for (const player of game.players.values()) {
    io?.to(rooms.player(game, player.id)).emit('game:finished', finishedPayload(game, player, ranks));
  }

  // Free the code now; drop the game from memory later.
  if (gamesByCode.get(game.code) === game) gamesByCode.delete(game.code);
  setTimeout(() => games.delete(game.id), FINISHED_GAME_KEEP_MS).unref();
}

async function saveFinalRanks(game, ranked) {
  await transaction(async (client) => {
    await client.query(`UPDATE games SET status = 'finished', ended_at = now() WHERE id = $1`, [game.id]);
    if (ranked.length === 0) return;
    await client.query(
      `UPDATE attempts SET rank = r.rank, completed_at = now()
       FROM unnest($1::bigint[], $2::int[]) AS r(attempt_id, rank)
       WHERE attempts.id = r.attempt_id`,
      [ranked.map((p) => p.attemptId), ranked.map((p) => p.rank)],
    );
  });
}

// ---------------------------------------------------------------------------
// Reconnects: replay the current screen to one socket
// ---------------------------------------------------------------------------

export function sendCurrentState(socket, game, player) {
  const isHost = !player;
  const round = currentRound(game);

  switch (game.phase) {
    case 'lobby':
      socket.emit('lobby:update', lobbyPayload(game));
      break;
    case 'question': {
      const answered = player ? (round.answers.get(player.id)?.option ?? null) : null;
      socket.emit('question:show', questionPayload(game, round, answered));
      if (isHost) socket.emit('question:progress', progressPayload(game, round));
      break;
    }
    case 'reveal':
      cacheLeaderboard(game);
      socket.emit('question:reveal', revealPayload(game, round));
      if (player) socket.emit('answer:result', answerResultPayload(game, round, player, currentRanks(game)));
      break;
    case 'leaderboard':
      cacheLeaderboard(game);
      if (player) socket.emit('answer:result', answerResultPayload(game, round, player, currentRanks(game)));
      socket.emit('leaderboard:show', leaderboardPayload(game));
      break;
    case 'finished': {
      const ranks = currentRanks(game);
      socket.emit('game:finished', finishedPayload(game, player, ranks));
      break;
    }
    default:
      break;
  }
}

export function hostInfo(game, baseUrl) {
  return {
    gameId: game.id,
    code: game.code,
    joinUrl: `${baseUrl}/join/${game.code}`,
    quizTitle: game.quizTitle,
    totalQuestions: game.questions.length,
    phase: game.phase,
  };
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

// Games left open by a previous process cannot continue (their state was in memory).
export async function markInterruptedGamesAbandoned() {
  const { rows } = await query(
    `UPDATE games SET status = 'abandoned', ended_at = now()
     WHERE status IN ('lobby', 'running')
     RETURNING id, quiz_id`,
  );
  for (const row of rows) {
    logger.warn(
      { event: 'game.abandoned', game_id: row.id, quiz_id: row.quiz_id },
      'Game was still open when the server stopped; marked abandoned',
    );
  }
}
