// Helpers shared by the account pages' forms (and the avatar builder).

import { ApiError } from '../lib/api.js';

// Mirrors the server rule (src/auth/routes.js); checked here for instant feedback.
export const PASSWORD_MIN = 8;

export function errorMessage(err, fallback = 'Could not reach the server. Try again.') {
  return err instanceof ApiError ? err.message : fallback;
}

// Each input's error element has id "<field>-error", linked via aria-describedby.
export function setFieldError(form, field, message) {
  const input = form.elements[field];
  const error = document.getElementById(`${field}-error`);
  if (!input || !error) return false;
  error.textContent = message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  return true;
}

// Client-side checks for instant feedback; the server validates everything again.
// `problems` maps field names to a message, or false when fine. Returns true if any.
export function showFieldErrors(form, problems) {
  const invalid = Object.keys(problems).filter((field) => problems[field]);
  for (const field of invalid) setFieldError(form, field, problems[field]);
  if (invalid.length > 0) form.elements[invalid[0]].focus();
  return invalid.length > 0;
}

export function clearErrors(form, notice) {
  for (const input of form.querySelectorAll('[aria-invalid]')) {
    setFieldError(form, input.name, '');
  }
  setNotice(notice, '');
}

// An empty message hides the box (.notice:empty in base.css).
export function setNotice(notice, message, kind = 'error') {
  notice.textContent = message;
  notice.classList.remove('notice--error', 'notice--success');
  if (message) notice.classList.add(`notice--${kind}`);
}

export function showError(form, notice, err) {
  const message = errorMessage(err, 'Could not reach the server. Check your connection and try again.');
  const field = err instanceof ApiError ? err.body?.field : undefined;
  if (field && setFieldError(form, field, message)) {
    form.elements[field].focus();
  } else {
    setNotice(notice, message);
    notice.focus();
  }
}

// Disabled while the request runs so a double tap can't submit twice.
export async function whileBusy(form, label, work) {
  const button = form.querySelector('button[type="submit"]');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// Only same-site paths are allowed ("//evil.example" counts as another site),
// to prevent an open redirect after login.
export function safeNext(fallback = '/') {
  const next = new URLSearchParams(window.location.search).get('next');
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  try {
    const url = new URL(next, window.location.origin);
    if (url.origin !== window.location.origin) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

// The token is a one-time secret, so it is removed from the URL and history.
export function takeTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') ?? '';
  if (token) {
    params.delete('token');
    const rest = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
  }
  return token;
}
