#!/usr/bin/env node
// Fault-injection switches CLI (see src/chaos/). Run inside the app container:
//
//   docker compose exec app npm run chaos -- status
//   npm run chaos -- <switch> on|off [--actor <name>]
//   npm run chaos -- all off
//
// Env: CHAOS_TOKEN (required, same as the app), CHAOS_URL (default
// http://localhost:$CHAOS_PORT or 9091), CHAOS_ACTOR (audit name).

import os from 'node:os';

const BASE_URL = (process.env.CHAOS_URL || `http://localhost:${process.env.CHAOS_PORT || 9091}`).replace(/\/$/, '');
const TOKEN = process.env.CHAOS_TOKEN || '';

const USAGE = `Usage:
  npm run chaos -- status
  npm run chaos -- <switch> on|off [--actor <name>]
  npm run chaos -- all off [--actor <name>]
--actor is who you are, for the chaos_audit table (default: $CHAOS_ACTOR, then $USER).`;

function fail(message) {
  console.error(`chaos: ${message}`);
  process.exit(1);
}

// Actor name for chaos_audit; never empty.
function defaultActor() {
  const fromEnv = [process.env.CHAOS_ACTOR, process.env.USER, process.env.LOGNAME].map((v) => v?.trim()).find(Boolean);
  if (fromEnv) return fromEnv;
  try {
    return os.userInfo().username.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseArgs(argv) {
  const args = [];
  let actor = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--actor') {
      actor = argv[i + 1] ?? '';
      i += 1;
    } else if (argv[i].startsWith('--actor=')) {
      actor = argv[i].slice('--actor='.length);
    } else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else {
      args.push(argv[i]);
    }
  }
  return { args, actor: actor.trim() || defaultActor() };
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    fail(
      `could not reach the chaos server at ${BASE_URL} (${err.cause?.code ?? err.message}).\n` +
        '  Is the app running with CHAOS_TOKEN set? Run this inside the app container:\n' +
        '  docker compose exec app npm run chaos -- status',
    );
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) fail('the server refused the token. Is CHAOS_TOKEN the same here as in the app?');
  if (!res.ok) fail(data.error ?? `HTTP ${res.status}`);
  return data;
}

function printStatus(switches) {
  const width = Math.max(...Object.keys(switches).map((name) => name.length));
  for (const [name, { on, breaks }] of Object.entries(switches)) {
    console.log(`  ${on ? 'ON ' : 'off'}  ${name.padEnd(width)}  ${breaks}`);
  }
}

async function main() {
  const { args, actor } = parseArgs(process.argv.slice(2));
  if (!TOKEN) fail('CHAOS_TOKEN is not set (it must match the app\'s).');

  const [what, state] = args;
  if (!what || what === 'status') {
    const { switches } = await call('GET', '/chaos');
    printStatus(switches);
    return;
  }

  if (!['on', 'off'].includes(state) || args.length > 2) fail(`expected "on" or "off".\n${USAGE}`);
  const on = state === 'on';

  if (what === 'all') {
    if (on) fail('"all on" is not allowed: turn switches on one at a time.');
    const { switches } = await call('GET', '/chaos');
    const lit = Object.keys(switches).filter((name) => switches[name].on);
    for (const name of lit) await call('POST', `/chaos/${name}`, { on: false, actor });
    console.log(lit.length ? `Turned off: ${lit.join(', ')}` : 'Every switch was already off.');
    printStatus((await call('GET', '/chaos')).switches);
    return;
  }

  const result = await call('POST', `/chaos/${what}`, { on, actor });
  console.log(`${what} is now ${on ? 'ON' : 'off'}${result.changed ? '' : ' (it already was)'}.`);
  if (!result.audited) console.log('Warning: the change could not be written to chaos_audit, so it will not survive a restart.');
  printStatus(result.switches);
}

main().catch((err) => fail(err.message));
