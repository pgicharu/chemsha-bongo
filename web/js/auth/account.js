// Account page: profile, email confirmation status, log out.

import { api } from '../lib/api.js';
import { avatarImg } from '../lib/avatar.js';
import { renderNav, requireLogin } from '../lib/session.js';
import { errorMessage, setNotice } from './forms.js';

const me = await requireLogin();
renderNav({ confirmBanner: false });

const notice = document.getElementById('notice');
const resend = document.getElementById('resend-button');

document.getElementById('avatar').append(avatarImg(me.avatar, { size: 96, alt: 'Your avatar' }));
document.getElementById('name').textContent = me.name;
document.getElementById('email').textContent = me.email;

const confirmed = document.createElement('span');
confirmed.className = me.confirmed ? 'badge badge--yes' : 'badge badge--no';
confirmed.textContent = me.confirmed ? 'Yes' : 'Not yet';
document.getElementById('confirmed').append(confirmed);

if (!me.confirmed) {
  setNotice(notice, 'Confirm your email to create quizzes and save scores. Check your inbox for the link.');
  resend.hidden = false;
}
document.getElementById('account').removeAttribute('aria-busy');

resend.addEventListener('click', async () => {
  resend.disabled = true;
  try {
    const result = await api.post('/api/confirm/resend');
    setNotice(
      notice,
      result.alreadyConfirmed ? 'Your email is already confirmed.' : `Sent! Check ${me.email} (and the spam folder).`,
      'success',
    );
  } catch (err) {
    setNotice(notice, errorMessage(err));
  } finally {
    resend.disabled = false;
  }
  notice.focus();
});

document.getElementById('logout-button').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try {
    await api.post('/api/logout');
  } finally {
    window.location.href = '/';
  }
});
