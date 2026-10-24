// Fault-injection switches and their in-memory state. App code checks isOn()
// at each injection point. Imports nothing from the app so any module can use it.

import { context, ROOT_CONTEXT } from '@opentelemetry/api';

// All off by default.
export const SWITCHES = {
  crash: 'the process dies from an uncaught exception; Docker restarts it',
  'db-down': 'the database becomes unreachable; /health still says OK',
  'socket-storm': 'about 30% of player sockets drop every 5 seconds',
  'slow-scoring': 'scoring an answer runs a slow SQL function (about 4 s)',
  'leaderboard-leak': 'a leaderboard cache that never evicts, until the container runs out of memory',
  'email-down': 'the SMTP server accepts connections and never answers (10 s timeout)',
};

export const SWITCH_NAMES = Object.keys(SWITCHES);

const ONE_SHOT = new Set(['crash']);

const state = new Map(SWITCH_NAMES.map((name) => [name, false]));
const listeners = new Map(SWITCH_NAMES.map((name) => [name, []]));

export function isSwitch(name) {
  return state.has(name);
}

// Called on hot paths; keep cheap.
export function isOn(name) {
  return state.get(name) === true;
}

export function allStates() {
  return Object.fromEntries(state);
}

export function onSwitch(name, fn) {
  if (!isSwitch(name)) throw new Error(`Unknown chaos switch: ${name}`);
  listeners.get(name).push(fn);
}

// Returns true if the state changed.
export async function setSwitch(name, on) {
  if (!isSwitch(name)) throw new Error(`Unknown chaos switch: ${name}`);
  const enabled = Boolean(on);
  if (state.get(name) === enabled) return false;
  state.set(name, enabled);
  // Root context so long-lived work started here does not inherit the untraced control request.
  for (const fn of listeners.get(name)) await context.with(ROOT_CONTEXT, () => fn(enabled));
  return true;
}

// Switches to restore at startup from chaos_audit rows (oldest first), so
// faults that restart the process persist. `crash` is one-shot to avoid a restart loop.
export function latestStates(rows) {
  const latest = new Map();
  for (const row of rows) {
    if (isSwitch(row.switch) && !ONE_SHOT.has(row.switch)) latest.set(row.switch, Boolean(row.enabled));
  }
  return [...latest].filter(([, enabled]) => enabled).map(([name]) => name);
}
