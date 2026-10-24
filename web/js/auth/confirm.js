// Email confirmation (/confirm?token=...). Works logged in or not: the token
// alone identifies the account.

import { api } from '../lib/api.js';
import { getMe, renderNav } from '../lib/session.js';
import { errorMessage, setNotice, takeTokenFromUrl } from './forms.js';

const notice = document.getElementById('notice');
const actions = document.getElementById('actions');
const primary = document.getElementById('primary-link');
const token = takeTokenFromUrl();

async function confirm() {
  if (!token) {
    setNotice(notice, 'This page needs the link from your welcome email. Open the link in the email again.');
    return;
  }
  try {
    const result = await api.post('/api/confirm', { token });
    setNotice(
      notice,
      result.alreadyConfirmed ? 'Your email was already confirmed. You are all set!' : 'Thanks! Your email is confirmed.',
      'success',
    );
  } catch (err) {
    setNotice(notice, errorMessage(err, 'Could not reach the server. Reload the page to try again.'));
    primary.textContent = 'Go to my account';
    primary.href = '/account';
  }
}

// Confirm before drawing the header so it shows the updated status.
await confirm();
if (!(await getMe())) {
  primary.textContent = 'Log in';
  primary.href = '/login';
}
actions.hidden = false;
renderNav({ confirmBanner: false });
