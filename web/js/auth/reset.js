// Reset password: the page the emailed link opens (/reset?token=...).

import { api } from '../lib/api.js';
import { renderNav } from '../lib/session.js';
import {
  clearErrors,
  PASSWORD_MIN,
  setNotice,
  showError,
  showFieldErrors,
  takeTokenFromUrl,
  whileBusy,
} from './forms.js';

const form = document.getElementById('reset-form');
const notice = document.getElementById('notice');
const token = takeTokenFromUrl();

renderNav();

if (!token) {
  form.hidden = true;
  setNotice(notice, 'This page needs the link from your password reset email. Ask for a new one below.');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, notice);

  const password = form.elements.password.value;
  const tooShort = password.length < PASSWORD_MIN;
  const invalid = showFieldErrors(form, {
    password: tooShort && `Your password needs at least ${PASSWORD_MIN} characters.`,
    password2: !tooShort && password !== form.elements.password2.value && "The two passwords don't match.",
  });
  if (invalid) return;

  try {
    await whileBusy(form, 'Saving…', () => api.post('/api/password/reset', { token, password }));
    form.hidden = true;
    setNotice(notice, 'Your password has been changed. ', 'success');
    const login = document.createElement('a');
    login.href = '/login';
    login.textContent = 'Log in with your new password';
    notice.append(login);
    notice.focus();
  } catch (err) {
    showError(form, notice, err);
  }
});
