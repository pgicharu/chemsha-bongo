// Helpers shared by game/host.js, game/play.js and selfpaced/take.js.

import { io } from 'socket.io-client';

// Every option shows a shape and a letter, so nothing relies on colour alone.
export const LETTERS = ['A', 'B', 'C', 'D'];
export const SHAPES = { A: '▲', B: '◆', C: '●', D: '■' };

// Text always goes in as text nodes, never innerHTML, so names can't inject markup.
export function el(tag, className = '', children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of [children].flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function showScreen(name) {
  for (const section of document.querySelectorAll('section[data-screen]')) {
    section.hidden = section.dataset.screen !== name;
  }
}

export function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

export function formatPoints(n) {
  return Number(n ?? 0).toLocaleString('en');
}

export function plural(n, word) {
  return n === 1 ? word : `${word}s`;
}

// ---- Answer tiles and buttons ----

// Hidden from screen readers, which read the letter from the button label.
export function answerMark(letter) {
  const mark = el('span', 'answer__mark', `${SHAPES[letter]} ${letter}`);
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

export function answerTile(letter, text, extraClass = '') {
  const className = `answer answer--${letter.toLowerCase()} ${extraClass}`.trim();
  return el('div', className, [answerMark(letter), el('span', '', text)]);
}

export function answerButtons(options, onPick) {
  return LETTERS.map((letter) => {
    const button = el('button', `answer answer--${letter.toLowerCase()} play-answer`, [
      answerMark(letter),
      el('span', 'play-answer__text', options[letter]),
    ]);
    button.type = 'button';
    button.dataset.option = letter;
    button.setAttribute('aria-label', `${SHAPES[letter]} ${letter}: ${options[letter]}`);
    button.addEventListener('click', () => onPick(letter));
    return button;
  });
}

export function lockAnswerButtons(buttons, chosen) {
  for (const button of buttons) {
    button.disabled = true;
    button.classList.toggle('is-chosen', button.dataset.option === chosen);
  }
}

// ---- Answer result on a phone (play.html and take.html; ids "result-..." / "fb-...") ----

const RESULT_TEXT = {
  correct: 'Correct!',
  wrong: 'Wrong',
  late: 'Too late!',
  none: 'No answer',
};

export function drawAnswerResult(prefix, { result, points, totalScore, correctOption }, options) {
  const $ = (name) => document.getElementById(`${prefix}-${name}`);
  const badge = $('badge');
  badge.textContent = RESULT_TEXT[result] ?? result;
  badge.className = `result-badge result-badge--${result}`;
  $('points').textContent = `+${formatPoints(points)} points`;
  $('correct').hidden = result === 'correct';
  $('correct-tile').replaceChildren(answerTile(correctOption, options?.[correctOption] ?? ''));
  $('total').textContent = formatPoints(totalScore);
  showScore(totalScore);
}

export function showScore(score) {
  const bar = document.getElementById('bar-score');
  bar.textContent = `${formatPoints(score)} pts`;
  bar.hidden = false;
}

// ---- Socket.IO ----

const ACK_TIMEOUT_MS = 8000;

// Socket.IO reconnects by itself; 'connect' fires again each time and the page re-joins.
export function connect() {
  return io({ reconnectionDelayMax: 3000 });
}

// Resolves with the server's ack, or { ok: false, code: 'timeout' } if none arrives in time.
export async function send(socket, event, payload = {}) {
  try {
    return await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, payload);
  } catch {
    return { ok: false, error: 'The server did not answer. Check your connection.', code: 'timeout' };
  }
}

// ---- Countdown ----

const TICK_MS = 200;
const LOW_TIME_MS = 5000;

// Counts down from the milliseconds left (sent by the server) on performance.now(),
// so a wrong device clock doesn't matter. Each tick recomputes the time left, so it
// never drifts.
export class Countdown {
  constructor(node, { onDone } = {}) {
    this.node = node;
    this.onDone = onDone;
    this.interval = null;
  }

  start(remainingMs) {
    this.stop();
    this.endsAt = performance.now() + remainingMs;
    this.tick();
    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  tick() {
    const leftMs = Math.max(0, this.endsAt - performance.now());
    const seconds = String(Math.ceil(leftMs / 1000));
    if (this.node.textContent !== seconds) this.node.textContent = seconds;
    this.node.classList.toggle('timer--low', leftMs <= LOW_TIME_MS);
    if (leftMs === 0) {
      this.stop();
      this.onDone?.();
    }
  }

  stop() {
    clearInterval(this.interval);
    this.interval = null;
  }
}
