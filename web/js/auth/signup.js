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

  // The same answer whether or not the address already has an account; the
  // email says which. The link in it logs in and continues to `next`.
  const body = { name, email, password, next };
  try {
    const result = await whileBusy(form, 'Creating account…', () => api.post('/api/signup', body));
    showDone(result, body);
  } catch (err) {
    showError(form, notice, err);
  }
});

function showDone({ emailSent }, body) {
  document.getElementById('signup-panel').hidden = true;
  document.getElementById('done-panel').hidden = false;
  const doneNotice = document.getElementById('done-notice');
  const resend = document.getElementById('resend-button');
  showSent(doneNotice, emailSent, body.email);

  // Sending the same sign-up again sends a fresh link.
  resend.addEventListener('click', async () => {
    resend.disabled = true;
    try {
      const result = await api.post('/api/signup', body);
      showSent(doneNotice, result.emailSent, body.email);
    } catch (err) {
      setNotice(doneNotice, errorMessage(err));
    } finally {
      resend.disabled = false;
    }
  });

  document.getElementById('done-title').focus();
}

function showSent(doneNotice, emailSent, email) {
  if (emailSent) {
    setNotice(doneNotice, `We sent a link to ${email}. Open it on this device to finish signing up. Check the spam folder if it doesn't arrive.`, 'success');
  } else {
    setNotice(doneNotice, "We couldn't send the email just now. Try again in a minute.");
  }
}

if (await getMe()) {
  window.location.replace(next);
} else {
  renderNav();
}
