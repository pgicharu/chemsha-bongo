// Quiz editor (/edit, or /edit?id=12). State lives in `questions`; adding, moving or
// removing a question redraws the whole list (at most 50). Server validation errors
// name a field, matched to inputs by data-field="...".

import { api, ApiError } from '../lib/api.js';
import { renderNav, requireLogin } from '../lib/session.js';
import { el, OPTION_LETTERS, optionMark, param } from './common.js';
import { questionsFromCsv } from './import-csv.js';

renderNav();
const me = await requireLogin();

// Mirrors LIMITS in src/quizzes/validate.js; only the server enforces them.
const LIMITS = {
  questionsMax: 50,
  promptMax: 300,
  optionMax: 120,
  timeLimitMin: 5,
  timeLimitMax: 120,
  timeLimitDefault: 20,
};

const form = document.getElementById('quiz-form');
const heading = document.getElementById('heading');
const titleInput = document.getElementById('title');
const dueField = document.getElementById('due-field');
const dueInput = document.getElementById('due_at');
const modeHint = document.getElementById('mode-hint');
const questionList = document.getElementById('questions');
const addButton = document.getElementById('add-question');
const saveButton = document.getElementById('save');
const saveStatus = document.getElementById('save-status');
const errorSummary = document.getElementById('error-summary');

// --- State ------------------------------------------------------------------

let quizId = param('id');
let questions = []; // [{ key, prompt, options: { A, B, C, D }, correct_option, time_limit_seconds }]
let locked = false; // true once the quiz has been played (see the server's PUT route)
let savedSnapshot = ''; // to detect unsaved changes

// Cards get a stable key, not their index, so radio group names survive moves.
let nextKey = 1;

function blankQuestion() {
  return {
    key: nextKey++,
    prompt: '',
    options: { A: '', B: '', C: '', D: '' },
    correct_option: null,
    time_limit_seconds: String(LIMITS.timeLimitDefault),
  };
}

function currentMode() {
  return form.elements.mode.value;
}

// --- Dates ------------------------------------------------------------------
// datetime-local inputs use local time with no zone; the API uses ISO times in UTC.

function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(value) {
  return value ? new Date(value).toISOString() : null;
}

// --- Request payload --------------------------------------------------------

function payload() {
  const mode = currentMode();
  return {
    title: titleInput.value,
    mode,
    due_at: mode === 'self_paced' ? localInputToIso(dueInput.value) : null,
    questions: questions.map((q) => ({
      prompt: q.prompt,
      options: { ...q.options },
      correct_option: q.correct_option,
      time_limit_seconds: q.time_limit_seconds,
    })),
  };
}

function isDirty() {
  return JSON.stringify(payload()) !== savedSnapshot;
}

function markSaved() {
  savedSnapshot = JSON.stringify(payload());
}

window.addEventListener('beforeunload', (event) => {
  if (!form.hidden && isDirty()) {
    event.preventDefault();
    event.returnValue = ''; // older browsers need this as well
  }
});

// --- Mode and due date ------------------------------------------------------

function showModeDetails() {
  const selfPaced = currentMode() === 'self_paced';
  dueField.hidden = !selfPaced;
  modeHint.textContent = selfPaced
    ? 'People open the share link and play on their own, one attempt each.'
    : 'You run it on a projector; players join on their phones with a 6-digit code.';
  dueInput.min = isoToLocalInput(new Date().toISOString());
}

form.elements.mode.forEach((radio) => radio.addEventListener('change', showModeDetails));

// --- Question cards ---------------------------------------------------------

function renderQuestions() {
  clearErrors(); // error messages are tied to positions, which may have changed
  questionList.replaceChildren(...questions.map(questionCard));
  const full = questions.length >= LIMITS.questionsMax;
  addButton.disabled = locked || full;
  addButton.textContent = full ? `A quiz can have at most ${LIMITS.questionsMax} questions` : '+ Add question';
}

function questionCard(q, i) {
  const number = i + 1;
  const field = `questions.${i}`;
  const id = (name) => `q${q.key}-${name}`;

  const prompt = el('textarea', {
    className: 'input',
    id: id('prompt'),
    rows: 2,
    maxLength: LIMITS.promptMax,
    value: q.prompt,
    disabled: locked,
    placeholder: 'e.g. Which tool stores logs?',
    dataset: { field: `${field}.prompt` },
    onInput: (e) => {
      q.prompt = e.target.value;
      clearError(`${field}.prompt`);
    },
  });

  const time = el('input', {
    className: 'input input--short',
    id: id('time'),
    type: 'number',
    inputMode: 'numeric',
    min: LIMITS.timeLimitMin,
    max: LIMITS.timeLimitMax,
    step: 1,
    value: q.time_limit_seconds,
    disabled: locked,
    dataset: { field: `${field}.time_limit_seconds` },
    onInput: (e) => {
      q.time_limit_seconds = e.target.value;
      clearError(`${field}.time_limit_seconds`);
    },
  });

  return el('li', { className: 'question-card', dataset: { key: q.key } }, [
    el('div', { className: 'question-card__head' }, [el('h3', {}, `Question ${number}`), questionTools(i)]),
    el('div', { className: 'field' }, [el('label', { htmlFor: id('prompt') }, 'Question'), prompt]),
    el('fieldset', { className: 'field options', dataset: { field: `${field}.correct_option` } }, [
      el('legend', {}, 'Answers: fill in all four and tick the correct one'),
      ...OPTION_LETTERS.map((letter) => optionRow(q, i, letter)),
    ]),
    el('div', { className: 'field field--inline' }, [el('label', { htmlFor: id('time') }, 'Time limit (seconds)'), time]),
  ]);
}

// aria-labels name the question so screen readers don't hear "Move up" fifty times.
function questionTools(i) {
  const number = i + 1;
  const tool = (text, label, disabled, onClick, extra = {}) =>
    el('button', { type: 'button', className: 'icon-button', 'aria-label': label, disabled: locked || disabled, onClick, ...extra }, text);

  return el('div', { className: 'question-card__tools' }, [
    tool('↑', `Move question ${number} up`, i === 0, () => moveQuestion(i, -1), { dataset: { action: 'up' } }),
    tool('↓', `Move question ${number} down`, i === questions.length - 1, () => moveQuestion(i, +1), { dataset: { action: 'down' } }),
    tool('✕', `Remove question ${number}`, questions.length === 1, () => removeQuestion(i), { className: 'icon-button icon-button--danger' }),
  ]);
}

function optionRow(q, i, letter) {
  const number = i + 1;
  const field = `questions.${i}`;
  return el('div', { className: 'option-row' }, [
    optionMark(letter),
    el('input', {
      className: 'input option-row__text',
      type: 'text',
      maxLength: LIMITS.optionMax,
      value: q.options[letter],
      disabled: locked,
      'aria-label': `Question ${number}, answer ${letter}`,
      dataset: { field: `${field}.options.${letter}` },
      onInput: (e) => {
        q.options[letter] = e.target.value;
        clearError(`${field}.options.${letter}`);
      },
    }),
    el('label', { className: 'correct-pick' }, [
      el('input', {
        type: 'radio',
        name: `q${q.key}-correct`, // one group per card; the key survives moves
        value: letter,
        checked: q.correct_option === letter,
        disabled: locked,
        'aria-label': `Answer ${letter} is correct`,
        onChange: () => {
          q.correct_option = letter;
          clearError(`${field}.correct_option`);
        },
      }),
      el('span', { 'aria-hidden': 'true' }, 'Correct'),
    ]),
  ]);
}

// Keeps focus on the same button of the same card so repeated presses keep working.
function moveQuestion(index, step) {
  const target = index + step;
  [questions[index], questions[target]] = [questions[target], questions[index]];
  const key = questions[target].key;
  renderQuestions();
  const card = questionList.querySelector(`[data-key="${key}"]`);
  const button = card.querySelector(`[data-action="${step < 0 ? 'up' : 'down'}"]`);
  (button.disabled ? card.querySelector('textarea') : button).focus();
}

function removeQuestion(index) {
  questions.splice(index, 1);
  renderQuestions();
  const cards = questionList.children;
  cards[Math.min(index, cards.length - 1)]?.querySelector('textarea')?.focus();
}

addButton.addEventListener('click', () => {
  questions.push(blankQuestion());
  renderQuestions();
  questionList.lastElementChild.querySelector('textarea').focus();
});

// --- Import from CSV --------------------------------------------------------
// Imported questions are only added to the editor; saving runs the usual checks.

const importBox = document.getElementById('import-box');
const importButton = document.getElementById('import-button');
const importFile = document.getElementById('import-file');
const importStatus = document.getElementById('import-status');

function showImportStatus(kind, lines) {
  importStatus.className = `notice notice--${kind}`;
  importStatus.replaceChildren(...lines.map((line) => el('p', {}, line)));
  importStatus.hidden = false;
}

function isBlank(q) {
  return q.prompt.trim() === '' && OPTION_LETTERS.every((letter) => q.options[letter].trim() === '');
}

importButton.addEventListener('click', () => importFile.click());

importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = ''; // so choosing the same file again (after fixing it) fires 'change'
  if (!file) return;

  const kept = questions.filter((q) => !isBlank(q));
  const { questions: imported, errors } = questionsFromCsv(await file.text(), {
    maxQuestions: LIMITS.questionsMax - kept.length,
    defaultTimeLimit: LIMITS.timeLimitDefault,
  });
  if (errors) {
    showImportStatus('error', [`Nothing was imported from ${file.name}:`, ...errors]);
    return;
  }

  questions = [...kept, ...imported.map((q) => ({ ...q, key: nextKey++ }))];
  renderQuestions();
  const count = imported.length === 1 ? '1 question' : `${imported.length} questions`;
  showImportStatus('ok', [`Imported ${count} from ${file.name}. Check them, then press Save quiz.`]);
});

// --- Error messages ---------------------------------------------------------

function fieldElement(field) {
  return form.querySelector(`[data-field="${CSS.escape(field)}"]`);
}

function errorId(field) {
  return `error-${field.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

function clearError(field) {
  document.getElementById(errorId(field))?.remove();
  const target = fieldElement(field);
  target?.removeAttribute('aria-invalid');
  target?.removeAttribute('aria-describedby');
}

function clearErrors() {
  form.querySelectorAll('.field-error').forEach((node) => node.remove());
  form.querySelectorAll('[aria-invalid]').forEach((node) => {
    node.removeAttribute('aria-invalid');
    node.removeAttribute('aria-describedby');
  });
  errorSummary.hidden = true;
  errorSummary.replaceChildren();
}

function showError(field, message) {
  const target = fieldElement(field);
  if (!target) return;
  const id = errorId(field);
  const note = el('p', { className: 'field-error', id }, message);
  (target.closest('.option-row') ?? target).after(note);
  target.setAttribute('aria-invalid', 'true');
  target.setAttribute('aria-describedby', id);
}

function focusField(field) {
  const target = fieldElement(field);
  const focusable = target.matches('fieldset') ? target.querySelector('input:not([disabled])') : target;
  (focusable ?? target).focus();
}

function showSummary(messages) {
  const heading = messages.length === 1 ? 'Please fix this:' : `Please fix these ${messages.length} problems:`;
  errorSummary.replaceChildren(el('p', {}, el('strong', {}, heading)), el('ul', {}, messages.map(summaryLine)));
  errorSummary.hidden = false;
  errorSummary.focus();
}

function summaryLine({ field, message }) {
  if (!field || !fieldElement(field)) return el('li', {}, message);
  return el('li', {}, el('button', { type: 'button', className: 'link-button', onClick: () => focusField(field) }, message));
}

// --- Saving -----------------------------------------------------------------

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors();
  saveButton.disabled = true;
  saveStatus.textContent = 'Saving…';

  try {
    if (quizId) {
      await api.put(`/api/quizzes/${quizId}`, payload());
    } else {
      const created = await api.post('/api/quizzes', payload());
      quizId = String(created.id);
      history.replaceState(null, '', `/edit?id=${quizId}`);
      heading.textContent = 'Edit quiz';
    }
    markSaved();
    saveStatus.replaceChildren('Saved. ', el('a', { href: '/quizzes' }, 'Back to my quizzes'));
  } catch (err) {
    saveStatus.textContent = 'Not saved.';
    if (err instanceof ApiError && err.status === 400 && Array.isArray(err.body?.errors)) {
      err.body.errors.forEach(({ field, message }) => showError(field, message));
      showSummary(err.body.errors);
    } else {
      // 403 not confirmed, 409 questions locked, 404 deleted elsewhere, network...
      showSummary([{ message: err.message }]);
    }
  } finally {
    saveButton.disabled = !me.confirmed;
  }
});

// --- Locked quizzes ---------------------------------------------------------

const duplicateButton = document.getElementById('duplicate');
duplicateButton.addEventListener('click', async () => {
  duplicateButton.disabled = true;
  try {
    const copy = await api.post(`/api/quizzes/${quizId}/duplicate`);
    // Unsaved title changes are dropped, so beforeunload asks first if there are any.
    window.location.href = `/edit?id=${copy.id}`;
  } catch (err) {
    showSummary([{ message: `Couldn't duplicate: ${err.message}` }]);
    duplicateButton.disabled = false;
  }
});

// --- Start up ---------------------------------------------------------------

if (!me.confirmed) {
  const banner = document.getElementById('unconfirmed');
  banner.textContent =
    `You can't save quizzes until you confirm your email address. ` +
    `Open the link we sent to ${me.email}, then come back: you can keep drafting in the meantime.`;
  banner.hidden = false;
  saveButton.disabled = true;
}

async function loadQuiz() {
  heading.textContent = 'Edit quiz';
  const loading = document.getElementById('loading');
  loading.hidden = false;
  try {
    const quiz = await api.get(`/api/quizzes/${encodeURIComponent(quizId)}`);
    titleInput.value = quiz.title;
    form.elements.mode.value = quiz.mode;
    dueInput.value = isoToLocalInput(quiz.due_at);
    questions = quiz.questions.map((q) => ({
      key: nextKey++,
      prompt: q.prompt,
      options: { ...q.options },
      correct_option: q.correct_option,
      time_limit_seconds: String(q.time_limit_seconds),
    }));
    locked = quiz.questions_locked;
    document.getElementById('locked').hidden = !locked;
    document.title = `Edit: ${quiz.title} · Chemsha Bongo`;
    return true;
  } catch (err) {
    const loadError = document.getElementById('load-error');
    loadError.textContent =
      err instanceof ApiError && err.status === 404
        ? 'We couldn’t find that quiz. It may have been deleted.'
        : `Couldn't load the quiz: ${err.message}`;
    loadError.hidden = false;
    return false;
  } finally {
    loading.hidden = true;
  }
}

const ready = quizId ? await loadQuiz() : true;
if (ready) {
  if (!quizId) questions = [blankQuestion()];
  importBox.hidden = locked;
  showModeDetails();
  renderQuestions();
  markSaved();
  form.hidden = false;
}
