// My quizzes (/quizzes): the owner's quizzes and their actions.

import { api } from '../lib/api.js';
import { renderNav, requireLogin } from '../lib/session.js';
import { el, formatDateTime, MODE_LABELS, plural, shareUrl } from './common.js';

renderNav();
await requireLogin();

const list = document.getElementById('quiz-list');
const empty = document.getElementById('empty');
const loading = document.getElementById('loading');
const notice = document.getElementById('notice');

function showNotice(message, kind = 'ok') {
  notice.textContent = message;
  notice.className = `notice notice--${kind}`;
  notice.hidden = false;
}

async function load() {
  try {
    const { quizzes } = await api.get('/api/quizzes');
    loading.hidden = true;
    list.replaceChildren(...quizzes.map(quizCard));
    list.hidden = quizzes.length === 0;
    empty.hidden = quizzes.length > 0;
  } catch (err) {
    loading.textContent = `Couldn't load your quizzes: ${err.message}`;
  }
}

function quizCard(quiz) {
  const card = el('li', { className: 'quiz-card' });

  const meta = el('p', { className: 'quiz-card__meta' }, [
    el('span', { className: `badge badge--${quiz.mode}` }, MODE_LABELS[quiz.mode]),
    el('span', {}, plural(quiz.question_count, 'question')),
    el('span', {}, plural(quiz.attempt_count, 'result')),
    quiz.due_at ? el('span', {}, `${new Date(quiz.due_at) < new Date() ? 'Closed' : 'Due'} ${formatDateTime(quiz.due_at)}`) : null,
  ]);

  const extra = el('div', { className: 'quiz-card__extra' });

  const actions = el('div', { className: 'actions' }, [
    el('a', { className: 'button button--small button--plain', href: `/edit?id=${quiz.id}` }, 'Edit'),
    quiz.mode === 'live'
      ? el('a', { className: 'button button--small', href: `/host?quiz=${quiz.id}` }, 'Host live')
      : null,
    el('button', { type: 'button', className: 'button button--small button--plain', onClick: () => copyLink(quiz, extra) }, 'Copy share link'),
    el('a', { className: 'button button--small button--plain', href: `/results?id=${quiz.id}` }, 'Results'),
    el('button', { type: 'button', className: 'button button--small button--plain', onClick: (e) => duplicate(quiz, e.currentTarget) }, 'Duplicate'),
    el('button', { type: 'button', className: 'button button--small button--danger', onClick: () => askDelete(quiz, card, extra) }, 'Delete'),
  ]);

  card.append(
    el('h2', { className: 'quiz-card__title' }, el('a', { href: `/edit?id=${quiz.id}` }, quiz.title)),
    meta,
    actions,
    extra,
  );
  return card;
}

// The clipboard API needs https or localhost; over plain http (e.g. a LAN address)
// the link is shown in a box to copy by hand.
async function copyLink(quiz, extra) {
  const url = shareUrl(quiz.share_slug);
  try {
    await navigator.clipboard.writeText(url);
    showNotice(`Link copied: ${url}`);
  } catch {
    const input = el('input', { className: 'input', type: 'text', value: url, readOnly: true, 'aria-label': 'Share link' });
    extra.replaceChildren(el('p', { className: 'hint' }, 'Copy this link:'), input);
    input.focus();
    input.select();
  }
}

async function duplicate(quiz, button) {
  button.disabled = true;
  try {
    await api.post(`/api/quizzes/${quiz.id}/duplicate`);
    await load();
    showNotice(`Made a copy of “${quiz.title}”. It is at the top of the list.`);
  } catch (err) {
    showNotice(`Couldn't duplicate: ${err.message}`, 'error');
    button.disabled = false;
  }
}

// In-page confirmation instead of window.confirm(), which blocks the page and is
// easy to click through.
function askDelete(quiz, card, extra) {
  const results = quiz.attempt_count > 0 ? ` and its ${plural(quiz.attempt_count, 'result')}` : '';
  const keep = el('button', { type: 'button', className: 'button button--small button--plain', onClick: () => extra.replaceChildren() }, 'Keep it');
  const yes = el(
    'button',
    {
      type: 'button',
      className: 'button button--small button--danger',
      onClick: async () => {
        yes.disabled = true;
        try {
          await api.delete(`/api/quizzes/${quiz.id}`);
          card.remove();
          showNotice(`Deleted “${quiz.title}”.`);
          if (list.children.length === 0) {
            list.hidden = true;
            empty.hidden = false;
          }
        } catch (err) {
          showNotice(`Couldn't delete: ${err.message}`, 'error');
          yes.disabled = false;
        }
      },
    },
    'Yes, delete',
  );

  extra.replaceChildren(
    el('div', { className: 'confirm', role: 'group', 'aria-label': 'Confirm delete' }, [
      el('p', {}, `Delete “${quiz.title}”${results}? This can’t be undone.`),
      el('div', { className: 'actions' }, [yes, keep]),
    ]),
  );
  keep.focus();
}

await load();
