// Socket.IO events for live games. Sockets are authenticated upstream
// (socket.data.user = { id, name, email, avatar, confirmed }).
//
// Client → server (every event takes an ack callback; on failure the ack is
// { ok: false, error, code } with a message safe to show):
//   host:open      { gameId }  ack { ok, gameId, code, joinUrl, quizTitle, totalQuestions, phase }
//   host:start     {}          ack { ok }
//   host:next      {}          ack { ok }  advances question → reveal → leaderboard/final → next question
//   host:end       {}          ack { ok }
//   player:join    { code }    ack { ok, gameId, quizTitle, totalQuestions, you: { id, name, avatar } }
//   player:answer  { questionNo, option: 'A'|'B'|'C'|'D' }
//                  ack { ok, result: 'locked'|'late'|'duplicate'|'closed', message }
//
// Server → client:
//   lobby:update      { players: [{ id, name, avatar }], count }
//   question:show     { questionNo, total, prompt, options: { A, B, C, D }, timeLimitSeconds,
//                       remainingMs, answered }   remainingMs is a duration (client clocks are not trusted)
//   question:progress { answered, total }                                   host only
//   question:reveal   { questionNo, total, prompt, options, correctOption, counts: { A, B, C, D } }
//   answer:result     { questionNo, result: 'correct'|'wrong'|'late'|'none', option, correctOption,
//                       points, totalScore, rank, playerCount }            per player
//   leaderboard:show  { questionNo, total, top: [{ name, avatar, score, rank }] }
//   game:finished     { top5, playerCount, quizTitle, you?: { score, rank, correctCount, total } }
//
// Clients re-send host:open / player:join on every (re)connect; the server
// rejoins the rooms and replays the current screen (sendCurrentState).

import { trace } from '@opentelemetry/api';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { watchForSocketStorm } from '../chaos/socket-storm.js';
import {
  GameError,
  rooms,
  getGame,
  getGameByCode,
  useSocketServer,
  joinGame,
  playerConnected,
  playerDisconnected,
  hostConnected,
  hostDisconnected,
  startGame,
  nextStep,
  finishGame,
  submitAnswer,
  sendCurrentState,
  hostInfo,
} from './engine.js';

function confirmedUser(socket) {
  const user = socket.data.user;
  if (!user) throw new GameError('Please log in first.', 'unauthenticated');
  if (!user.confirmed) {
    throw new GameError(
      'Please confirm your email address first: click the link in the welcome email we sent you.',
      'unconfirmed',
    );
  }
  return user;
}

function hostedGame(socket) {
  const game = socket.data.role === 'host' ? getGame(socket.data.gameId) : null;
  if (!game) throw new GameError('Open the game first.', 'not_open');
  if (String(socket.data.user?.id) !== game.hostId) throw new GameError('Only the host can do that.', 'not_owner');
  return game;
}

// Always answers the ack; GameErrors become user-facing messages, anything else is logged.
function on(socket, eventName, handler) {
  socket.on(eventName, async (...args) => {
    // The ack is the last argument; with no payload it is the only one.
    const ack = typeof args.at(-1) === 'function' ? args.pop() : null;
    const payload = args[0];
    const reply = ack ?? (() => {});

    // The auto-instrumentation names every span "receive /"; rename it after the event.
    const span = trace.getActiveSpan();
    if (span) {
      span.updateName(`receive ${eventName}`);
      if (socket.data.user) span.setAttribute('user.id', socket.data.user.id);
      if (socket.data.gameId) span.setAttribute('game.id', socket.data.gameId);
    }
    try {
      const result = await handler(payload && typeof payload === 'object' ? payload : {});
      reply({ ok: true, ...result });
    } catch (err) {
      if (err instanceof GameError) {
        reply({ ok: false, error: err.message, code: err.code });
        return;
      }
      logger.error(
        {
          event: 'game.socket_error',
          socket_event: eventName,
          game_id: socket.data.gameId,
          player_id: socket.data.user?.id,
          question_no: payload?.questionNo,
          err,
        },
        'Error handling a game event',
      );
      reply({ ok: false, error: 'Something went wrong. Please try again.', code: 'server_error' });
    }
  });
}

export function registerGameSockets(io) {
  useSocketServer(io);
  watchForSocketStorm(io); // `socket-storm` fault-injection switch

  io.on('connection', (socket) => {
    // ---------------------------------------------------------------- host
    on(socket, 'host:open', async ({ gameId }) => {
      const user = confirmedUser(socket);
      const game = getGame(gameId);
      if (!game) throw new GameError('This game is no longer running. Start a new one from My quizzes.', 'not_found');
      if (String(user.id) !== game.hostId) throw new GameError('Only the quiz owner can host this game.', 'not_owner');

      socket.data.gameId = game.id;
      socket.data.role = 'host';
      socket.join([rooms.game(game), rooms.host(game)]);
      hostConnected(game, socket.id);
      sendCurrentState(socket, game, null);
      return hostInfo(game, config.baseUrl);
    });

    on(socket, 'host:start', async () => {
      await startGame(hostedGame(socket));
      return {};
    });

    on(socket, 'host:next', async () => {
      await nextStep(hostedGame(socket));
      return {};
    });

    on(socket, 'host:end', async () => {
      await finishGame(hostedGame(socket), 'ended_by_host');
      return {};
    });

    // -------------------------------------------------------------- player
    on(socket, 'player:join', async ({ code }) => {
      const user = confirmedUser(socket);
      const cleanCode = String(code ?? '').trim();
      if (!/^\d{6}$/.test(cleanCode)) throw new GameError('A game code is 6 digits.', 'bad_code');

      const game = getGameByCode(cleanCode);
      if (!game) throw new GameError('No game with that code. Check the code on the big screen.', 'not_found');

      const { player } = await joinGame(game, user);
      socket.data.gameId = game.id;
      socket.data.role = 'player';
      socket.join([rooms.game(game), rooms.player(game, player.id)]);
      playerConnected(game, player, socket.id);
      sendCurrentState(socket, game, player);
      return {
        gameId: game.id,
        quizTitle: game.quizTitle,
        totalQuestions: game.questions.length,
        you: { id: player.id, name: player.name, avatar: player.avatar },
      };
    });

    on(socket, 'player:answer', async ({ questionNo, option }) => {
      // Read the clock first: this is the time the answer is judged by.
      const receivedAtMs = Date.now();
      const game = socket.data.role === 'player' ? getGame(socket.data.gameId) : null;
      if (!game) throw new GameError("You're not in a game. Join with the code first.", 'not_joined');
      return submitAnswer(game, socket.data.user.id, { questionNo, option }, receivedAtMs);
    });

    // ---------------------------------------------------------- disconnect
    socket.on('disconnect', () => {
      const game = getGame(socket.data.gameId);
      if (!game) return;
      if (socket.data.role === 'host') {
        hostDisconnected(game, socket.id);
      } else if (socket.data.role === 'player') {
        const player = game.players.get(String(socket.data.user?.id));
        if (player) playerDisconnected(game, player, socket.id);
      }
    });
  });
}
