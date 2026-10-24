// Tests for the production secret checks in src/config.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Read by config.js at import time; nothing connects.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:1/test';
process.env.SESSION_SECRET ??= 'test';
const { checkProductionSecrets } = await import('../src/config.js');

const GOOD_SECRET = 'a'.repeat(64);

test('production: refuses the example SESSION_SECRET', () => {
  assert.throws(
    () => checkProductionSecrets({ env: 'production', sessionSecret: 'change-me-to-a-long-random-string', grafanaDbPassword: '' }),
    /SESSION_SECRET is still the example value.*openssl rand -hex 32.*DEPLOY\.md/,
  );
});

test('production: refuses a SESSION_SECRET shorter than 32 characters', () => {
  assert.throws(
    () => checkProductionSecrets({ env: 'production', sessionSecret: 'a'.repeat(31), grafanaDbPassword: '' }),
    /at least 32 characters/,
  );
});

test('production: refuses the example GRAFANA_DB_PASSWORD', () => {
  assert.throws(
    () => checkProductionSecrets({ env: 'production', sessionSecret: GOOD_SECRET, grafanaDbPassword: 'grafana-reader-local-only' }),
    /GRAFANA_DB_PASSWORD is still the example value/,
  );
});

test('production: accepts real secrets, and an empty GRAFANA_DB_PASSWORD (no Grafana user)', () => {
  checkProductionSecrets({ env: 'production', sessionSecret: GOOD_SECRET, grafanaDbPassword: 'x'.repeat(48) });
  checkProductionSecrets({ env: 'production', sessionSecret: GOOD_SECRET, grafanaDbPassword: '' });
});

test('development: the example values are fine', () => {
  checkProductionSecrets({ env: 'development', sessionSecret: 'change-me-to-a-long-random-string', grafanaDbPassword: 'grafana-reader-local-only' });
  checkProductionSecrets({ env: 'development', sessionSecret: 'dev', grafanaDbPassword: '' });
});
