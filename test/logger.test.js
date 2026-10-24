// Tests for src/logger.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Required by config.js; nothing connects.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:1/test';
process.env.SESSION_SECRET ??= 'test';
const { redactTokens } = await import('../src/logger.js');

test('redactTokens: blanks out the token of an email link', () => {
  assert.equal(redactTokens('/reset?token=abc123-_XYZ'), '/reset?token=REDACTED');
  assert.equal(redactTokens('/confirm?x=1&token=abc&y=2'), '/confirm?x=1&token=REDACTED&y=2');
});

test('redactTokens: leaves other URLs alone', () => {
  assert.equal(redactTokens('/api/quizzes/42?page=2'), '/api/quizzes/42?page=2');
  assert.equal(redactTokens('/play/my-tokens?mytoken=1'), '/play/my-tokens?mytoken=1');
});
