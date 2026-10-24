// Email confirmation (/confirm?token=...&next=/path). The token alone
// identifies the account; a successful confirmation also logs in.

import { api } from '../lib/api.js';
import { getMe, renderNav } from '../lib/session.js';
import { errorMessage, safeNext, setNotice, takeTokenFromUrl } from './forms.js';

const notice = document.getElementById('notice');
const actions = document.getElementById('actions');
const primary = document.getElementById('primary-link');
const token = takeTokenFromUrl();
const next = safeNext('/');

// Returns true once the address is confirmed.
async function confirm() {
  if (!token) {
    setNotice(notice, 'This page needs the link from your welcome email. Open the link in the email again.');
    return false;
  }
  try {
    const result = await api.post('/api/confirm', { token });
    setNotice(
      notice,
      result.alreadyConfirmed ? 'Your email was already confirmed. You are all set!' : 'Thanks! Your email is confirmed.',
      'success',
    );
    primary.textContent = next === '/' ? 'Start playing' : 'Continue';
    primary.href = next;
    return true;
  } catch (err) {
    setNotice(notice, errorMessage(err, 'Could not reach the server. Reload the page to try again.'));
    primary.textContent = 'Sign up again';
    primary.href = '/signup';
    return false;
  }
}

// Confirm before drawing the header so it shows the updated status.
const confirmed = await confirm();
const me = await getMe();
if (confirmed && me && next !== '/') {
  // Straight back to what they were doing, e.g. joining a game.
  window.location.replace(next);
} else if (confirmed && !me) {
  primary.textContent = 'Log in';
  primary.href = `/login?next=${encodeURIComponent(next)}`;
}
actions.hidden = false;
renderNav({ confirmBanner: false });
