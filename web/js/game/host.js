// Host projector screen: /host?quiz=<quizId>. Creates a game, then replaces the URL
// with /host?game=<gameId> so a reload re-opens the same game. The server runs the
// clock and scoring; events are documented in src/game/sockets.js.

import { renderSVG } from 'uqr';
import { api, ApiError } from '../lib/api.js';
import { requireLogin, sendToLogin } from '../lib/session.js';
import { avatarImg } from '../lib/avatar.js';
import { LETTERS, el, answerMark, answerTile, showScreen, formatPoints, plural, connect, send, Countdown } from './common.js';

const $ = (id) => document.getElementById(id);

const state = {
  gameId: null,
  totalQuestions: 0,
  phase: 'loading',
  questionNo: 0,
  playerCount: 0,
  botsAllowed: false,
  seenPlayers: new Set(),
};

// Longer texts get smaller type on the projector (.q-prompt--long, .host-answers--long).
const LONG_PROMPT = 70;
const LONG_OPTION = 28;

const countdown = new Countdown($('q-timer'));

function showError(title, text) {
  $('error-title').textContent = title;
  $('error-text').textContent = text;
  $('controls').hidden = true;
  countdown.stop();
  showScreen('error');
}

// ---- Next button (its label depends on the phase) ----

function setPhase(phase) {
  state.phase = phase;
  const next = $('next-button');
  const labels = {
    lobby: 'Start',
    question: 'Skip',
    reveal: state.questionNo === state.totalQuestions ? 'Final results' : 'Next',
    leaderboard: 'Next question',
  };
  $('controls').hidden = !(phase in labels);
  next.textContent = labels[phase] ?? '';
  next.disabled = false;
  if (phase !== 'question') countdown.stop();
  showScreen(phase);
}

async function pressNext() {
  const event = state.phase === 'lobby' ? 'host:start' : 'host:next';
  const button = $('next-button');
  if (button.disabled || $('controls').hidden) return;
  button.disabled = true; // no double presses while the server works
  const reply = await send(socket, event);
  button.disabled = false;
  if (!reply.ok) alert(reply.error);
}

async function pressEnd() {
  if (!confirm('End the game now for everyone? Scores so far are kept.')) return;
  const reply = await send(socket, 'host:end');
  if (!reply.ok) alert(reply.error);
}

$('next-button').addEventListener('click', pressNext);
$('end-button').addEventListener('click', pressEnd);

// Presentation clickers send PageDown or ArrowRight.
document.addEventListener('keydown', (event) => {
  if (['ArrowRight', 'PageDown', ' '].includes(event.key) && event.target === document.body) {
    event.preventDefault();
    pressNext();
  }
});

// ---- Drawing each screen ----

function drawLobby({ players, count }) {
  $('player-count').textContent = count;
  $('player-word').textContent = plural(count, 'player');
  $('lobby-empty').hidden = count > 0;
  const list = $('lobby-players');
  list.replaceChildren(
    ...players.map((player) => {
      const isNew = !state.seenPlayers.has(player.id);
      state.seenPlayers.add(player.id);
      return el('li', `avatar-grid__item${isNew ? ' is-new' : ''}`, [
        avatarImg(player.avatar, { size: 96 }),
        el('span', 'avatar-grid__name', player.name),
      ]);
    }),
  );
  state.playerCount = count;
  updateBotsButton();
  // Only once: calling setPhase again would re-enable Start while a press is pending.
  if (state.phase === 'loading') setPhase('lobby');
}

// ---- "Add 5 bots" (only with ALLOW_BOTS=true): real accounts that play like phones ----

const BOTS_PER_CLICK = 5;
const MAX_PLAYERS = 50;

function updateBotsButton() {
  $('bots').hidden = !state.botsAllowed || state.playerCount >= MAX_PLAYERS;
}

async function addBots() {
  const button = $('add-bots');
  button.disabled = true;
  $('bots-status').textContent = 'Bots are joining…';
  try {
    const reply = await api.post(`/api/games/${state.gameId}/bots`, { count: BOTS_PER_CLICK });
    $('bots-status').textContent = `${reply.added} bots joined.`;
  } catch (err) {
    $('bots-status').textContent = err instanceof ApiError ? err.message : 'Could not reach the server.';
  } finally {
    button.disabled = false;
  }
}

$('add-bots').addEventListener('click', addBots);

function drawQuestion(question) {
  state.questionNo = question.questionNo;
  state.totalQuestions = question.total;
  $('q-count').textContent = `Question ${question.questionNo} of ${question.total}`;
  $('q-prompt').textContent = question.prompt;
  $('q-prompt').classList.toggle('q-prompt--long', question.prompt.length > LONG_PROMPT);
  const longest = Math.max(...LETTERS.map((letter) => question.options[letter].length));
  $('q-options').classList.toggle('host-answers--long', longest > LONG_OPTION);
  $('q-options').replaceChildren(
    ...LETTERS.map((letter) => {
      const tile = answerTile(letter, question.options[letter], 'host-answer');
      tile.setAttribute('aria-label', `${letter}: ${question.options[letter]}`);
      return tile;
    }),
  );
  setPhase('question');
  countdown.start(question.remainingMs);
}

function drawProgress({ answered, total }) {
  $('q-answered').textContent = answered;
  $('q-total').textContent = total;
}

function drawReveal({ questionNo, total, prompt, options, correctOption, counts }) {
  state.questionNo = questionNo;
  state.totalQuestions = total;
  $('r-count').textContent = `Question ${questionNo} of ${total}`;
  $('r-prompt').textContent = prompt;
  $('r-prompt').classList.toggle('q-prompt--long', prompt.length > LONG_PROMPT);

  const most = Math.max(1, ...LETTERS.map((letter) => counts[letter]));
  const summary = [];
  $('r-chart').replaceChildren(
    ...LETTERS.map((letter) => {
      const isCorrect = letter === correctOption;
      const bar = el('div', `chart__bar answer--${letter.toLowerCase()}`);
      bar.style.height = `${(counts[letter] / most) * 100}%`;
      summary.push(`${letter}: ${counts[letter]}${isCorrect ? ' (correct)' : ''}`);
      return el('div', `chart__col${isCorrect ? ' chart__col--correct' : ' chart__col--dim'}`, [
        el('span', 'chart__count', counts[letter]),
        el('div', 'chart__track', bar),
        el('div', `chart__label answer answer--${letter.toLowerCase()}`, [
          answerMark(letter),
          el('span', 'chart__text', options[letter]),
          isCorrect ? el('span', 'chart__tick', '✓') : null,
        ]),
      ]);
    }),
  );
  $('r-chart').setAttribute('aria-label', `How the room answered. ${summary.join(', ')}`);
  setPhase('reveal');
}

function boardRows(top) {
  return top.map((player) =>
    el('li', 'board__row', [
      el('span', 'board__rank', player.rank),
      avatarImg(player.avatar, { size: 72 }),
      el('span', 'board__name', player.name),
      el('span', 'board__score', formatPoints(player.score)),
    ]),
  );
}

function drawLeaderboard({ questionNo, total, top }) {
  $('board-title').textContent = `Top 5 after question ${questionNo} of ${total}`;
  $('board').replaceChildren(...boardRows(top));
  setPhase('leaderboard');
}

// Tied players share a rank, so blocks are placed by list position and show the real
// rank. The list stays in rank order for screen readers; game.css reorders it visually.
function podiumPlace(player, place) {
  if (!player) {
    // Fewer than three players: keep the empty slot so the podium stays centred.
    const empty = el('li', `podium__place podium__place--${place} podium__place--empty`, el('div', 'podium__block'));
    empty.setAttribute('aria-hidden', 'true');
    return empty;
  }
  return el('li', `podium__place podium__place--${place}`, [
    avatarImg(player.avatar, { size: 128 }),
    el('span', 'podium__name', player.name),
    el('span', 'podium__score', `${formatPoints(player.score)} pts`),
    el('div', 'podium__block', el('span', '', player.rank)),
  ]);
}

function drawFinished({ top5, playerCount }) {
  $('final-podium').replaceChildren(...[0, 1, 2].map((i) => podiumPlace(top5[i], i + 1)));
  $('final-board').replaceChildren(...boardRows(top5.slice(3)));
  $('final-board').hidden = top5.length <= 3;
  $('final-note').textContent = `${playerCount} ${plural(playerCount, 'player')}. Thanks for playing!`;
  setPhase('finished');
  $('bar-code').hidden = true;
}

// ---- Start-up ----

async function createGame(quizId) {
  if (!quizId) {
    showError('Which quiz?', 'Open My quizzes and press "Host live" on one of your live quizzes.');
    return null;
  }
  try {
    const { gameId } = await api.post('/api/games', { quizId });
    window.history.replaceState(null, '', `/host?game=${gameId}`);
    return gameId;
  } catch (err) {
    let text = 'Could not reach the server. Check your connection and reload.';
    if (err?.body?.code === 'unconfirmed') {
      text = 'Please confirm your email address first: click the link in the welcome email we sent you.';
    } else if (err instanceof ApiError) {
      text = err.message;
    }
    showError('Could not start a game', text);
    return null;
  }
}

function checkBotsAllowed() {
  api
    .get('/api/bots')
    .then(({ enabled }) => {
      state.botsAllowed = enabled;
      updateBotsButton();
    })
    .catch(() => {});
}

// QR of the join link, drawn locally by uqr so no outside service sees it. Error
// correction M survives a washed-out projector; the 4-module border is the quiet
// zone cameras need on a dark screen.
function drawJoinQr(joinUrl) {
  const qr = $('join-qr');
  const svg = renderSVG(joinUrl, { ecc: 'M', border: 4 });
  qr.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  qr.alt = `QR code: ${joinUrl}`;
  qr.hidden = false;
}

function drawGameInfo({ quizTitle, code, joinUrl, phase }) {
  $('quiz-title').textContent = quizTitle;
  document.title = `${quizTitle} · Chemsha Bongo`;
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  $('lobby-code').textContent = spaced;
  $('join-url').textContent = joinUrl.replace(/^https?:\/\//, '');
  drawJoinQr(joinUrl);
  $('bar-code').textContent = `Code ${spaced}`;
  $('bar-code').hidden = phase === 'finished';
}

function openGame() {
  const socket = connect();

  socket.on('connect', async () => {
    $('connection').textContent = '';
    // Sent on every connect, including reconnects, so the screen catches up with the game.
    const reply = await send(socket, 'host:open', { gameId: state.gameId });
    if (reply.code === 'timeout') {
      // Connected but no reply: reconnect, which sends host:open again.
      socket.disconnect().connect();
      return;
    }
    if (!reply.ok) {
      showError('Cannot open this game', reply.error);
      socket.disconnect();
      return;
    }
    state.totalQuestions = reply.totalQuestions;
    drawGameInfo(reply);
  });

  socket.on('disconnect', () => {
    $('connection').textContent = 'Reconnecting…';
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'unauthenticated') sendToLogin();
    else $('connection').textContent = 'Reconnecting…';
  });

  socket.on('lobby:update', drawLobby);
  socket.on('question:show', drawQuestion);
  socket.on('question:progress', drawProgress);
  socket.on('question:reveal', drawReveal);
  socket.on('leaderboard:show', drawLeaderboard);
  socket.on('game:finished', drawFinished);
  return socket;
}

await requireLogin();
const params = new URLSearchParams(window.location.search);
state.gameId = Number(params.get('game')) || (await createGame(Number(params.get('quiz'))));

// Used by pressNext() and pressEnd(), which only run after the socket is open.
let socket = null;
if (state.gameId) {
  checkBotsAllowed();
  socket = openGame();
}
