// Sign-up helpers: the `next` path in email links and the account-exists email.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { safeNextPath } from '../src/auth/next-path.js';
import { accountExistsEmail } from '../src/email/templates.js';

test('safeNextPath: only paths on this site', () => {
  assert.equal(safeNextPath('/join/123456'), '/join/123456');
  assert.equal(safeNextPath('/play?code=123456'), '/play?code=123456');
  for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'join/1', '/a b', '/a\nb', '', null, 42, `/${'a'.repeat(300)}`]) {
    assert.equal(safeNextPath(bad), null, String(bad));
  }
});

test('accountExistsEmail: links to log in and reset, name escaped in HTML', () => {
  const mail = accountExistsEmail({ name: '<b>Amina</b>', loginLink: 'https://x.example/login', resetLink: 'https://x.example/forgot' });
  assert.equal(mail.template, 'account_exists');
  assert.match(mail.text, /https:\/\/x\.example\/login/);
  assert.match(mail.text, /https:\/\/x\.example\/forgot/);
  assert.match(mail.html, /&lt;b&gt;Amina&lt;\/b&gt;/);
  assert.doesNotMatch(mail.html, /<b>Amina/);
});
