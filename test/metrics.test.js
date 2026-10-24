// Tests for src/metrics.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { routeLabel, registry } from '../src/metrics.js';

// Just enough of Express's req and res for routeLabel().
const req = (fields = {}) => ({ baseUrl: '', ...fields });
const res = (locals = {}) => ({ locals });

test('routeLabel: a matched route gives its PATTERN, not the URL', () => {
  const label = routeLabel(req({ originalUrl: '/api/quizzes/42', route: { path: '/api/quizzes/:id' } }), res());
  assert.equal(label, '/api/quizzes/:id');
});

test('routeLabel: a router mounted under a prefix keeps the prefix', () => {
  const label = routeLabel(req({ baseUrl: '/admin', route: { path: '/users/:id' } }), res());
  assert.equal(label, '/admin/users/:id');
});

test('routeLabel: a file served by express.static is "static"', () => {
  assert.equal(routeLabel(req(), res({ servedStatic: true })), 'static');
});

test('routeLabel: anything else is "unmatched"', () => {
  assert.equal(routeLabel(req(), res()), 'unmatched');
  assert.equal(routeLabel(req(), res({ servedStatic: false })), 'unmatched');
});

test('every answer result series exists at 0 from start-up', async () => {
  const text = await registry.metrics();
  for (const result of ['correct', 'wrong', 'late']) {
    assert.match(text, new RegExp(`^chemsha_answers_total\\{result="${result}"\\} 0$`, 'm'));
  }
});

test('the scoring histogram has buckets well past 4 seconds', async () => {
  const text = await registry.metrics();
  assert.match(text, /^chemsha_answer_scoring_seconds_bucket\{le="10"\} 0$/m);
});

test('/metrics lists every chemsha metric and the HTTP histogram', async () => {
  const text = await registry.metrics();
  for (const name of [
    'chemsha_players_connected',
    'chemsha_games_active',
    'chemsha_answers_total',
    'chemsha_answer_scoring_seconds',
    'chemsha_socket_disconnects_total',
    'http_request_duration_seconds',
    'chemsha_emails_sent_total',
    'process_cpu_seconds_total',
  ]) {
    assert.match(text, new RegExp(`^# TYPE ${name} `, 'm'), `${name} is missing`);
  }
});
