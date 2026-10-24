// Self-paced quiz: /take?slug=k3m9x2p7. The server runs the clock and scoring and
// records when each question was served, so a refresh never buys extra time.
// API: src/selfpaced/routes.js.

import { api, ApiError } from '../lib/api.js';
import { requireLogin } from '../lib/session.js';
import {
  answerButtons,
  lockAnswerButtons,
  drawAnswerResult,
  showScore,
  showScreen,
  formatPoints,
  plural,
  Countdown,
} from '../game/common.js';

const $ = (id) => document.getElementById(id);

const slug = new URLSearchParams(window.location.search).get('slug') ?? '';
const base = `/api/play/${encodeURIComponent(slug)}`;

const state = {
  question: null,
  buttons: [],
  answering: false, // true from the tap until the server answers: blocks double taps
};

const countdown = new Countdown($('q-timer'), {
  // Out of time locally. An in-flight answer waits for the server's verdict (it
  // allows a short grace period).
  onDone: () => {
    if (!state.answering) show('timeup');
  },
});

function show(screen) {
  if (screen !== 'question') countdown.stop();
  showScreen(screen);
}

function showError(text, { title = 'Hmm.', href = '/', label = 'Home' } = {}) {
  $('error-title').textContent = title;
  $('error-text').textContent = text;
  $('error-action').href = href;
  $('error-action').textContent = label;
  show('error');
}

// Remembers Start for this tab so a refresh skips the intro. sessionStorage can be
// unavailable (some private modes); the intro then shows again.
const startedKey = `take:${slug}`;
function markStarted() {
  try {
    sessionStorage.setItem(startedKey, '1');
  } catch {
    // not available: fine
  }
}
function startedBefore() {
  try {
    return sessionStorage.getItem(startedKey) === '1';
  } catch {
    return false;
  }
}

// ---- Screens ----

function showFinished({ score, correctCount, total }, { already = false } = {}) {
  $('final-title').textContent = already ? 'Already taken' : 'All done!';
  $('final-line').textContent = already
    ? `You've already taken this quiz. Your score: ${formatPoints(score)}`
    : `You scored ${formatPoints(score)} points`;
  $('final-score').textContent = formatPoints(score);
  $('final-correct').textContent = `${correctCount} / ${total}`;
  showScore(score);
  show('finished');
}

function showQuestion(question) {
  state.question = question;
  state.answering = false;

  $('q-count').textContent = `${question.questionNo} / ${question.total}`;
  $('q-prompt').textContent = question.prompt;
  $('q-error').textContent = '';
  state.buttons = answerButtons(question.options, answer);
  $('q-options').replaceChildren(...state.buttons);

  const nextLabel = question.questionNo === question.total ? 'See your score' : 'Next question';
  $('fb-next').textContent = nextLabel;
  $('timeup-next').textContent = nextLabel;

  if (question.remainingMs <= 0) {
    show('timeup');
  } else {
    show('question');
    countdown.start(question.remainingMs);
  }
}

function showFeedback(reply) {
  drawAnswerResult('fb', reply, state.question.options);
  show('feedback');
  $('fb-next').focus();
}

// ---- Talking to the server ----

function showApiError(err) {
  if (err instanceof ApiError && err.body?.code === 'past_due') {
    showError('This quiz has closed: its due date has passed.', { title: 'Closed' });
  } else if (err instanceof ApiError) {
    showError(err.message);
  } else {
    showError('Could not reach the server. Check your connection and try again.', {
      title: 'Offline?',
      href: window.location.href,
      label: 'Try again',
    });
  }
}

async function nextQuestion() {
  show('loading');
  try {
    const reply = await api.post(`${base}/question`);
    if (reply.finished) showFinished(reply);
    else showQuestion(reply);
  } catch (err) {
    showApiError(err);
  }
}

async function answer(letter) {
  if (state.answering) return; // one answer per question
  state.answering = true;
  lockAnswerButtons(state.buttons, letter);

  try {
    const reply = await api.post(`${base}/answer`, { questionNo: state.question.questionNo, option: letter });
    state.answering = false;
    showFeedback(reply);
  } catch (err) {
    state.answering = false;
    if (err instanceof ApiError && err.status === 409) {
      // Already answered (another tab?) or no longer current: ask the server where things stand.
      await nextQuestion();
    } else if (err instanceof ApiError) {
      showApiError(err);
    } else {
      for (const button of state.buttons) button.disabled = false;
      $('q-error').textContent = 'Could not reach the server. Tap your answer again.';
    }
  }
}

$('fb-next').addEventListener('click', nextQuestion);
$('timeup-next').addEventListener('click', nextQuestion);
$('intro-go').addEventListener('click', () => {
  markStarted();
  nextQuestion();
});

// ---- Start-up ----

await requireLogin();

function showStartError(err) {
  const code = err instanceof ApiError ? err.body?.code : null;
  if (code === 'past_due') {
    showError('This quiz has closed: its due date has passed.', { title: 'Closed' });
  } else if (code === 'not_self_paced') {
    showError(err.message, { href: `/play`, label: 'Enter a game code' });
  } else if (code === 'unconfirmed') {
    showError('Confirm your email first: click the link in the welcome email we sent you. Then come back to this page.', {
      href: '/account',
      label: 'My account',
    });
  } else if (err instanceof ApiError && err.status === 404) {
    showError('We couldn’t find that quiz. Check the link with whoever sent it.');
  } else {
    showApiError(err);
  }
}

if (!slug) {
  showError('There is no quiz in this link. Check the link with whoever sent it.');
} else {
  try {
    const start = await api.post(`${base}/start`);
    $('quiz-title').textContent = start.quizTitle;
    document.title = `${start.quizTitle} · Chemsha Bongo`;

    if (start.answered > 0 || startedBefore()) {
      await nextQuestion();
    } else {
      $('intro-title').textContent = start.quizTitle;
      $('intro-count').textContent = `${start.totalQuestions} ${plural(start.totalQuestions, 'question')}.`;
      if (start.dueAt) {
        $('intro-due').textContent = `Finish before ${new Date(start.dueAt).toLocaleString()}.`;
        $('intro-due').hidden = false;
      }
      show('intro');
    }
  } catch (err) {
    if (err instanceof ApiError && err.body?.code === 'already_taken') {
      try {
        const [result, quiz] = await Promise.all([api.get(`${base}/result`), api.get(`/api/q/${encodeURIComponent(slug)}`)]);
        $('quiz-title').textContent = quiz.title;
        showFinished(result, { already: true });
      } catch (resultErr) {
        showApiError(resultErr);
      }
    } else {
      showStartError(err);
    }
  }
}
