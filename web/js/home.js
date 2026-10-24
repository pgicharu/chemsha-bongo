// Home page: join a game by its code, or create a quiz.

import { getMe, renderNav } from './lib/session.js';

renderNav();

// Re-checked here for browsers that skip the form's own validation.
const form = document.getElementById('join-form');
const input = document.getElementById('join-code');
const error = document.getElementById('join-error');

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = input.value.replace(/\D/g, '');
  if (code.length !== 6) {
    error.textContent = 'The code is 6 digits. You can see it on the big screen.';
    input.focus();
    return;
  }
  window.location.href = `/play?code=${code}`;
});

const links = document.getElementById('home-links');
const me = await getMe();

function paragraph(...parts) {
  const p = document.createElement('p');
  p.append(...parts);
  return p;
}

function link(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  return a;
}

if (me) {
  links.append(paragraph('Want to run a quiz of your own? Go to ', link('/quizzes', 'My quizzes'), '.'));
} else {
  links.append(
    paragraph(link('/signup', 'Sign up'), ' or ', link('/login', 'log in'), ' to play and to make your own quizzes.'),
  );
}
