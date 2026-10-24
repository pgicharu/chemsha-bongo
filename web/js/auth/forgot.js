// Forgotten password: ask for a reset link by email.

import { api } from '../lib/api.js';
import { renderNav } from '../lib/session.js';
import { clearErrors, setNotice, showError, showFieldErrors, whileBusy } from './forms.js';

const form = document.getElementById('forgot-form');
const notice = document.getElementById('notice');

renderNav();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, notice);

  const email = form.elements.email.value.trim();
  if (showFieldErrors(form, { email: !email && 'Please enter your email address.' })) return;

  try {
    // The server gives the same answer whether or not the account exists.
    const { message } = await whileBusy(form, 'Sending…', () => api.post('/api/password/forgot', { email }));
    setNotice(notice, `${message} Check your inbox (and the spam folder). The link works for 1 hour.`, 'success');
    notice.focus();
  } catch (err) {
    showError(form, notice, err);
  }
});
