// Tests for the fault-injection switches (src/chaos/).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { isTracingSuppressed } from '@opentelemetry/core';

import { SWITCH_NAMES, isOn, setSwitch, onSwitch, latestStates } from '../src/chaos/switches.js';
import { SUPPRESS_TRACING_KEY } from '../src/chaos/untraced.js';

// Required by config.js; nothing connects.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:1/test';
process.env.SESSION_SECRET ??= 'test';
const { tokenMatches, createControlServer } = await import('../src/chaos/control.js');

test('every switch starts off', () => {
  for (const name of SWITCH_NAMES) assert.equal(isOn(name), false, name);
});

test('setSwitch: flips the state, tells listeners once per change', async () => {
  const seen = [];
  onSwitch('socket-storm', (on) => seen.push(on));
  assert.equal(await setSwitch('socket-storm', true), true);
  assert.equal(await setSwitch('socket-storm', true), false); // no change
  assert.equal(isOn('socket-storm'), true);
  assert.equal(await setSwitch('socket-storm', false), true);
  assert.deepEqual(seen, [true, false]);
  await assert.rejects(() => setSwitch('no-such-switch', true));
});

test('latestStates: the latest row per switch wins; crash and unknown switches are never restored', () => {
  const rows = [
    { switch: 'db-down', enabled: true },
    { switch: 'leaderboard-leak', enabled: true },
    { switch: 'crash', enabled: true },
    { switch: 'db-down', enabled: false },
    { switch: 'retired-switch', enabled: true },
    { switch: 'email-down', enabled: false },
    { switch: 'email-down', enabled: true },
  ];
  assert.deepEqual(latestStates(rows).sort(), ['email-down', 'leaderboard-leak']);
  assert.deepEqual(latestStates([]), []);
});

test('tokenMatches: only the exact Bearer token', () => {
  assert.equal(tokenMatches('Bearer s3cret', 's3cret'), true);
  assert.equal(tokenMatches('Bearer s3cre', 's3cret'), false);
  assert.equal(tokenMatches('Bearer s3cret-and-more', 's3cret'), false);
  assert.equal(tokenMatches('s3cret', 's3cret'), false);
  assert.equal(tokenMatches(undefined, 's3cret'), false);
  assert.equal(tokenMatches('Bearer ', ''), false);
});

// untraced() relies on using the same context key as @opentelemetry/core.
test('untraced(): its key is the one @opentelemetry/core checks to suppress tracing', () => {
  assert.equal(isTracingSuppressed(ROOT_CONTEXT), false);
  assert.equal(isTracingSuppressed(ROOT_CONTEXT.setValue(SUPPRESS_TRACING_KEY, true)), true);
});

test('control server: needs the token, flips a switch and audits it', async () => {
  const audited = [];
  const server = createControlServer({ token: 't0ken', audit: { record: async (...row) => audited.push(row) } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: 'Bearer t0ken' };

  assert.equal((await fetch(`${base}/chaos`)).status, 401);
  assert.equal((await fetch(`${base}/chaos`, { headers: { Authorization: 'Bearer nope' } })).status, 401);

  const status = await (await fetch(`${base}/chaos`, { headers: auth })).json();
  assert.deepEqual(Object.keys(status.switches), SWITCH_NAMES);

  const post = (name, body) => fetch(`${base}/chaos/${name}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  assert.equal((await post('nope', { on: true })).status, 404);
  assert.equal((await post('slow-scoring', { on: 'yes' })).status, 400);

  const res = await post('slow-scoring', { on: true, actor: 'wanjiru' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).changed, true);
  assert.equal(isOn('slow-scoring'), true);
  await post('slow-scoring', { on: false, actor: 'wanjiru' });
  assert.equal(isOn('slow-scoring'), false);
  assert.deepEqual(audited, [
    ['slow-scoring', true, 'wanjiru'],
    ['slow-scoring', false, 'wanjiru'],
  ]);
});
