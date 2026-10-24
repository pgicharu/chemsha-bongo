// Current user and the shared page header. Imports css/nav.css so every page
// with the header gets its styles.

import '../../css/nav.css';
import { api, ApiError } from './api.js';
import { avatarImg } from './avatar.js';

let mePromise = null;

// The logged-in user or null. { fresh: true } bypasses the cached answer.
export async function getMe({ fresh = false } = {}) {
  if (!mePromise || fresh) {
    mePromise = api
      .get('/api/me')
      .then((body) => body.user)
      .catch(() => null);
  }
  return mePromise;
}

export function sendToLogin() {
  window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
}

// Returns the user, or redirects to login and never resolves.
export async function requireLogin() {
  const me = await getMe();
  if (me) return me;
  sendToLogin();
  return new Promise(() => {});
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(href, text, className = 'site-nav__link') {
  const a = el('a', className, text);
  a.href = href;
  if (window.location.pathname === href) a.setAttribute('aria-current', 'page');
  return a;
}

// confirmBanner: false hides the confirm-email banner (for pages that show
// their own message). Resolves once the header is filled in.
export async function renderNav({ confirmBanner = true } = {}) {
  const header = el('header', 'site-nav');
  const inner = el('div', 'site-nav__inner');
  header.append(inner);

  const home = link('/', 'Chemsha Bongo', 'site-nav__brand');
  const links = el('nav', 'site-nav__links');
  links.setAttribute('aria-label', 'Main');
  inner.append(home, links);

  const first = document.body.firstElementChild;
  if (first?.classList.contains('trim')) first.after(header);
  else document.body.prepend(header);

  const me = await getMe();

  if (!me) {
    const here = window.location.pathname + window.location.search;
    const next = window.location.pathname === '/' ? '' : `?next=${encodeURIComponent(here)}`;
    links.append(link(`/login${next}`, 'Log in'), link(`/signup${next}`, 'Sign up', 'site-nav__link site-nav__link--cta'));
    return;
  }

  links.append(link('/quizzes', 'My quizzes'), accountMenu(me));

  if (!me.confirmed && confirmBanner) {
    header.after(renderConfirmBanner());
  }
}

// A <details> menu: the browser handles opening and its screen reader state;
// this adds closing on Escape or a tap elsewhere.
function accountMenu(me) {
  const menu = el('details', 'site-nav__menu');
  const summary = el('summary', 'site-nav__link site-nav__menu-button');
  summary.append(
    avatarImg(me.avatar, { size: 36, alt: '' }),
    el('span', 'site-nav__menu-name', me.name),
    el('span', 'visually-hidden', ' (account menu)'),
  );
  if (['/account', '/avatar'].includes(window.location.pathname)) summary.classList.add('is-current');

  const panel = el('div', 'site-nav__menu-panel');
  const account = link('/account', 'My account', 'site-nav__menu-item');
  const avatar = link('/avatar', 'Edit avatar', 'site-nav__menu-item');
  const logout = el('button', 'site-nav__menu-item', 'Log out');
  logout.type = 'button';
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      await api.post('/api/logout');
    } finally {
      window.location.href = '/';
    }
  });
  panel.append(account, avatar, logout);
  menu.append(summary, panel);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      summary.focus();
    }
  });
  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  return menu;
}

function renderConfirmBanner() {
  const banner = el('div', 'confirm-banner');
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Email not confirmed');

  const inner = el('div', 'confirm-banner__inner');
  const text = el('p', 'confirm-banner__text', 'Confirm your email to create quizzes and save scores');
  const button = el('button', 'confirm-banner__button', 'Resend email');
  button.type = 'button';
  const status = el('p', 'confirm-banner__status');
  status.setAttribute('role', 'status');

  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Sending…';
    try {
      const result = await api.post('/api/confirm/resend');
      status.textContent = result.alreadyConfirmed
        ? 'Your email is already confirmed. Reload the page.'
        : 'Sent! Check your inbox (and the spam folder).';
    } catch (err) {
      status.textContent = err instanceof ApiError ? err.message : 'Could not reach the server. Try again.';
      button.disabled = false;
    }
  });

  inner.append(text, button, status);
  banner.append(inner);
  return banner;
}
