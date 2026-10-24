// Player screen: /play?code=123456. Joins with the code and follows the server's
// events (documented in src/game/sockets.js); the server runs the clock and scoring.

import { requireLogin, sendToLogin } from '../lib/session.js';
import { avatarImg } from '../lib/avatar.js';
import {
  el,
  answerTile,
  answerButtons,
  lockAnswerButtons,
  drawAnswerResult,
  showScreen,
  ordinal,
  formatPoints,
  plural,
  connect,
  send,
  Countdown,
} from './common.js';

const $ = (id) => document.getElementById(id);

const state = {
  phase: 'loading',
  question: null,
  options: null, // the current question's options, also after a reconnect during the reveal
  buttons: [],
  answering: false, // true from the tap until the server answers: blocks double taps
  answered: false,
  lastResult: null,
};

const countdown = new Countdown($('q-timer'), {
  // Time is up locally; the server still accepts an in-flight answer within a short
  // grace period.
  onDone: () => {
    if (state.phase === 'question' && !state.answered && !state.answering) showTimeUp("Time's up!");
  },
});

function show(screen) {
  state.phase = screen;
  if (screen !== 'question') countdown.stop();
  showScreen(screen);
}

function showError(text, { href = '/play', label = 'Try another code' } = {}) {
  $('error-text').textContent = text;
  $('error-action').href = href;
  $('error-action').textContent = label;
  show('error');
}

function showTimeUp(title) {
  $('timeup-title').textContent = title;
  show('timeup');
}

function showLocked(letter) {
  $('locked-choice').replaceChildren(answerTile(letter, state.options[letter]));
  show('locked');
}

// ---- Answering ----

async function answer(letter) {
  if (state.answering || state.answered) return;
  state.answering = true;
  lockAnswerButtons(state.buttons, letter);

  const { questionNo } = state.question;
  const reply = await send(socket, 'player:answer', { questionNo, option: letter });
  state.answering = false;
  // A newer question may have arrived meanwhile; ignore the stale reply.
  if (state.question?.questionNo !== questionNo) return;

  if (!reply.ok) {
    for (const button of state.buttons) button.disabled = false;
    $('q-error').textContent = reply.error;
    return;
  }

  state.answered = true;
  if (reply.result === 'late') showTimeUp('Too late!');
  else if (reply.result === 'closed') showTimeUp('This question has closed');
  else showLocked(letter); // 'locked', or 'duplicate' (the first tap already counted)
}

// ---- Server events ----

function onLobby({ count }) {
  $('lobby-count').textContent = `${count} ${plural(count, 'player')} in the game`;
  if (state.phase === 'loading' || state.phase === 'lobby') show('lobby');
}

function onQuestion(question) {
  state.question = question;
  state.options = question.options;
  state.answering = false;
  state.answered = question.answered != null;

  $('q-count').textContent = `${question.questionNo} / ${question.total}`;
  $('q-prompt').textContent = question.prompt;
  $('q-error').textContent = '';
  state.buttons = answerButtons(question.options, answer);
  $('q-options').replaceChildren(...state.buttons);

  if (state.answered) {
    // Answered before a reconnect: don't offer the buttons again.
    showLocked(question.answered);
  } else if (question.remainingMs <= 0) {
    showTimeUp("Time's up!");
  } else {
    show('question');
    countdown.start(question.remainingMs);
  }
}

// Only the options are needed: after a reconnect during the reveal there was no
// question:show, and the "answer was" tile needs the option text.
function onReveal({ options }) {
  state.options = options;
}

function onResult(result) {
  state.lastResult = result;
  drawAnswerResult('result', result, state.options);
  $('result-rank').textContent = `${ordinal(result.rank)} of ${result.playerCount}`;
  show('result');
}

function onLeaderboard() {
  const result = state.lastResult;
  $('board-total').textContent = formatPoints(result?.totalScore ?? 0);
  $('board-rank').textContent = result ? `${ordinal(result.rank)} of ${result.playerCount}` : '–';
  show('leaderboard');
}

function onFinished({ top5, playerCount, you }) {
  if (you) {
    $('final-rank').textContent = `You came ${ordinal(you.rank)} of ${playerCount}`;
    $('final-score').textContent = formatPoints(you.score);
    $('final-correct').textContent = `${you.correctCount} / ${you.total}`;
  }
  $('final-board').replaceChildren(
    ...top5.map((player) =>
      el('li', `mini-board__row${you && player.rank === you.rank && player.name === me.name ? ' is-you' : ''}`, [
        el('span', 'mini-board__rank', player.rank),
        avatarImg(player.avatar, { size: 40 }),
        el('span', 'mini-board__name', player.name),
        el('span', 'mini-board__score', formatPoints(player.score)),
      ]),
    ),
  );
  show('finished');
  socket.disconnect();
}

// ---- Start-up ----

const me = await requireLogin();
const code = (new URLSearchParams(window.location.search).get('code') ?? '').replace(/\D/g, '');
let socket = null;

if (!/^\d{6}$/.test(code)) {
  $('code-input').value = code;
  show('code');
  $('code-input').focus();
  $('code-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const typed = $('code-input').value.replace(/\D/g, '');
    if (typed.length !== 6) {
      $('code-error').textContent = 'The code is 6 digits. You can see it on the big screen.';
      return;
    }
    window.location.href = `/play?code=${typed}`;
  });
} else {
  $('lobby-avatar').replaceChildren(avatarImg(me.avatar, { size: 160, alt: 'Your avatar' }));
  $('lobby-name').textContent = me.name;

  socket = connect();

  // Sent on every connect, including reconnects: the server re-sends the current screen.
  socket.on('connect', async () => {
    $('offline').hidden = true;
    const reply = await send(socket, 'player:join', { code });
    if (reply.code === 'timeout') {
      // Connected but no reply: reconnect, which sends player:join again.
      $('offline').hidden = false;
      socket.disconnect().connect();
      return;
    }
    if (!reply.ok) {
      socket.disconnect();
      if (reply.code === 'unconfirmed') showError(reply.error, { href: '/', label: 'Home' });
      else showError(reply.error);
      return;
    }
    $('quiz-title').textContent = reply.quizTitle;
    document.title = `${reply.quizTitle} · Chemsha Bongo`;
  });

  socket.on('disconnect', (reason) => {
    // 'io client disconnect' means the page closed it (game over or error).
    if (reason !== 'io client disconnect') $('offline').hidden = false;
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'unauthenticated') sendToLogin();
    else $('offline').hidden = false;
  });

  socket.on('lobby:update', onLobby);
  socket.on('question:show', onQuestion);
  socket.on('question:reveal', onReveal);
  socket.on('answer:result', onResult);
  socket.on('leaderboard:show', onLeaderboard);
  socket.on('game:finished', onFinished);
}
