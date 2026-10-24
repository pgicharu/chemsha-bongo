// Results for one quiz (/results?id=12). Owner only: anyone else gets 404 from the API.

import { api, ApiError } from '../lib/api.js';
import { renderNav, requireLogin } from '../lib/session.js';
import { el, formatDateTime, MODE_LABELS, param, plural } from './common.js';

renderNav();
await requireLogin();

const quizId = param('id');
const rowsBody = document.getElementById('rows');
const scoreHeader = document.getElementById('score-header');
const sortArrow = document.getElementById('sort-arrow');

let attempts = []; // as the server sent them: newest game first, then by rank
let sortOrder = 'none'; // 'none' (server order), 'descending' or 'ascending' by score

function attemptRow(a) {
  const mode =
    a.kind === 'live'
      ? [MODE_LABELS.live, el('span', { className: 'muted' }, ` · game of ${formatDateTime(a.game_started_at ?? a.started_at)}`)]
      : MODE_LABELS.self_paced;

  return el('tr', {}, [
    el('th', { scope: 'row' }, a.player_name),
    el('td', { className: 'num' }, a.score.toLocaleString()),
    el('td', { className: 'num' }, a.correct_count),
    el('td', { className: 'num' }, a.rank ?? '–'),
    el('td', {}, mode),
    el('td', {}, a.completed_at ? formatDateTime(a.completed_at) : el('span', { className: 'muted' }, 'Didn’t finish')),
    el('td', {}, a.email),
  ]);
}

function renderRows() {
  const sorted = [...attempts];
  if (sortOrder === 'descending') sorted.sort((x, y) => y.score - x.score);
  if (sortOrder === 'ascending') sorted.sort((x, y) => x.score - y.score);
  rowsBody.replaceChildren(...sorted.map(attemptRow));

  if (sortOrder === 'none') scoreHeader.removeAttribute('aria-sort');
  else scoreHeader.setAttribute('aria-sort', sortOrder);
  sortArrow.textContent = { none: '↕', descending: '▼', ascending: '▲' }[sortOrder];
}

document.getElementById('sort-score').addEventListener('click', () => {
  sortOrder = sortOrder === 'descending' ? 'ascending' : 'descending';
  renderRows();
});

try {
  const data = await api.get(`/api/quizzes/${encodeURIComponent(quizId ?? '')}/results`);
  attempts = data.attempts;

  document.getElementById('heading').textContent = `Results: ${data.quiz.title}`;
  document.title = `Results: ${data.quiz.title} · Chemsha Bongo`;
  document.getElementById('attempt-count').textContent = data.summary.attempt_count;
  document.getElementById('average-score').textContent =
    data.summary.average_score === null ? '–' : data.summary.average_score.toLocaleString();

  const download = document.getElementById('download');
  download.href = `/api/quizzes/${data.quiz.id}/results.csv`;
  download.setAttribute('aria-label', `Download CSV, ${plural(attempts.length, 'row')}`);

  document.getElementById('no-attempts').hidden = attempts.length > 0;
  document.getElementById('table-wrap').hidden = attempts.length === 0;
  renderRows();
  document.getElementById('results').hidden = false;
} catch (err) {
  const loadError = document.getElementById('load-error');
  loadError.textContent =
    err instanceof ApiError && err.status === 404
      ? 'We couldn’t find that quiz. It may have been deleted, or it belongs to someone else.'
      : `Couldn't load the results: ${err.message}`;
  loadError.hidden = false;
} finally {
  document.getElementById('loading').hidden = true;
}
