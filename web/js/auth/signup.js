// Sign-up page. Supports ?next=/somewhere to continue afterwards (e.g. joining a game).

import { api } from '../lib/api.js';
import { getMe, renderNav } from '../lib/session.js';
import {
  clearErrors,
  errorMessage,
  PASSWORD_MIN,
  safeNext,
  setNotice,
  showError,
  showFieldErrors,
  whileBusy,
} from './forms.js';

const form = document.getElementById('signup-form');
const notice = document.getElementById('notice');
const next = safeNext('/');

document.getElementById('login-link').href = `/login${window.location.search}`;

// Attached before any `await`, so the browser never submits the form by
// itself with the password in the address bar (see login.js).
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, notice);

  const name = form.elements.name.value.trim();
  const email = form.elements.email.value.trim();
  const password = form.elements.password.value;
  const invalid = showFieldErrors(form, {
    name: !name && 'Please enter your name.',
    email: !email && 'Please enter your email address.',
    password: password.length < PASSWORD_MIN && `Your password needs at least ${PASSWORD_MIN} characters.`,
  });
  if (invalid) return;

  try {
    // Slow: the server sends the welcome email before answering.
    const result = await whileBusy(form, 'Creating account…', () => api.post('/api/signup', { name, email, password }));
    showDone(result, email);
  } catch (err) {
    showError(form, notice, err);
  }
});

function showDone({ user, emailSent }, email) {
  document.getElementById('signup-panel').hidden = true;
  document.getElementById('done-panel').hidden = false;
  document.getElementById('done-title').textContent = `Karibu, ${user.name}!`;
  document.getElementById('continue-link').href = next;

  const doneNotice = document.getElementById('done-notice');
  const resend = document.getElementById('resend-button');
  if (emailSent) {
    setNotice(doneNotice, `We sent a confirmation link to ${email}. Open it to create quizzes and save your scores.`, 'success');
  } else {
    setNotice(doneNotice, "Your account is ready, but we couldn't send the confirmation email. Try sending it again.");
    resend.hidden = false;
  }

  resend.addEventListener('click', async () => {
    resend.disabled = true;
    try {
      await api.post('/api/confirm/resend');
      setNotice(doneNotice, `We sent a confirmation link to ${email}.`, 'success');
      resend.hidden = true;
    } catch (err) {
      setNotice(doneNotice, errorMessage(err));
      resend.disabled = false;
    }
  });

  document.getElementById('done-title').focus();
}

if (await getMe()) {
  window.location.replace(next);
} else {
  renderNav();
}
