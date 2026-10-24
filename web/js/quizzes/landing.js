// Share-link page: /q/k3m9x2p7 (or /q?slug=...). Public, so it never shows the
// questions or answers.

import { api, ApiError } from '../lib/api.js';
import { renderNav, getMe } from '../lib/session.js';
import { formatDateTime, MODE_LABELS, plural } from './common.js';

renderNav();

function slugFromAddress() {
  const match = window.location.pathname.match(/^\/q\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : new URLSearchParams(window.location.search).get('slug');
}

function showLive() {
  const form = document.getElementById('live');
  const input = document.getElementById('code');
  const error = document.getElementById('code-error');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // People often type the code as "482 913", the way the projector shows it.
    const code = input.value.replace(/\s+/g, '');
    if (!/^[0-9]{6}$/.test(code)) {
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    window.location.href = `/play?code=${code}`;
  });
  input.addEventListener('input', () => {
    error.hidden = true;
    input.removeAttribute('aria-invalid');
  });
  form.hidden = false;
}

async function showSelfPaced(quiz) {
  document.getElementById('question-count').textContent = plural(quiz.question_count, 'question');
  const due = document.getElementById('due');
  const closed = quiz.due_at !== null && new Date(quiz.due_at) <= new Date();
  if (!quiz.due_at) {
    due.textContent = 'No due date';
  } else if (closed) {
    due.textContent = `Closed ${formatDateTime(quiz.due_at)}`;
  } else {
    due.textContent = formatDateTime(quiz.due_at);
  }
  document.getElementById('self-paced').hidden = false;

  const start = document.getElementById('start');
  const status = document.getElementById('self-paced-status');
  start.href = `/take?slug=${encodeURIComponent(quiz.share_slug)}`;

  // 404 means not started yet, the usual case.
  let attempt = null;
  if (await getMe()) {
    attempt = await api.get(`/api/play/${encodeURIComponent(quiz.share_slug)}/result`).catch(() => null);
  }

  if (attempt?.finished) {
    status.textContent = `You’ve already taken this quiz — your score: ${attempt.score.toLocaleString()} (${attempt.correctCount} of ${attempt.total} correct).`;
    status.hidden = false;
  } else if (closed) {
    status.textContent = 'Closed: the due date has passed, so this quiz can’t be taken any more.';
    status.hidden = false;
  } else {
    if (attempt) start.textContent = 'Continue';
    start.hidden = false;
  }
}

const slug = slugFromAddress();
const loadError = document.getElementById('load-error');

try {
  if (!slug) throw new ApiError(404, 'No quiz in this link');
  const quiz = await api.get(`/api/q/${encodeURIComponent(slug)}`);

  document.title = `${quiz.title} · Chemsha Bongo`;
  document.getElementById('kicker').textContent = `${MODE_LABELS[quiz.mode]} quiz`;
  document.getElementById('title').textContent = quiz.title;
  document.getElementById('owner').textContent = `By ${quiz.owner_name} · ${plural(quiz.question_count, 'question')}`;

  if (quiz.mode === 'live') showLive();
  else await showSelfPaced(quiz);

  document.getElementById('landing').hidden = false;
} catch (err) {
  loadError.textContent =
    err instanceof ApiError && err.status === 404
      ? 'We couldn’t find that quiz. Check the link with whoever sent it.'
      : `Couldn't load the quiz: ${err.message}`;
  loadError.hidden = false;
} finally {
  document.getElementById('loading').hidden = true;
}
