// Login page. Supports ?next=/somewhere to go back where the user came from.

import { api } from '../lib/api.js';
import { getMe, renderNav } from '../lib/session.js';
import { clearErrors, safeNext, showError, showFieldErrors, whileBusy } from './forms.js';

const form = document.getElementById('login-form');
const notice = document.getElementById('notice');
const next = safeNext('/');

document.getElementById('signup-link').href = `/signup${window.location.search}`;

// Attached before any `await`: until then the browser would submit a GET with
// the password in the URL (and in server logs).
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, notice);

  const email = form.elements.email.value.trim();
  const password = form.elements.password.value;
  const invalid = showFieldErrors(form, {
    email: !email && 'Please enter your email address.',
    password: !password && 'Please enter your password.',
  });
  if (invalid) return;

  try {
    await whileBusy(form, 'Logging in…', () => api.post('/api/login', { email, password }));
    window.location.href = next;
  } catch (err) {
    showError(form, notice, err);
  }
});

if (await getMe()) {
  window.location.replace(next);
} else {
  renderNav();
}
