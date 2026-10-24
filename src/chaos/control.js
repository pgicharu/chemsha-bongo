// Fault-injection control server: GET /chaos, POST /chaos/<switch> { on, actor }.
// Requires `Authorization: Bearer <CHAOS_TOKEN>`. Listens on 127.0.0.1 on
// CHAOS_PORT; never publish or proxy this port. Requests bypass Express, so
// they are not logged, metered or traced; each change is recorded in chaos_audit.

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { SWITCHES, SWITCH_NAMES, allStates, isSwitch, setSwitch, latestStates } from './switches.js';
import { untraced } from './untraced.js';
// Switches with no hook elsewhere in the app.
import './db-down.js';

// Constant-time compare; hashing first gives timingSafeEqual equal-length inputs.
export function tokenMatches(authorizationHeader, token) {
  if (!token || typeof authorizationHeader !== 'string') return false;
  const given = authorizationHeader.startsWith('Bearer ') ? authorizationHeader.slice('Bearer '.length) : '';
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(token));
}

function describe() {
  const states = allStates();
  return Object.fromEntries(SWITCH_NAMES.map((name) => [name, { on: states[name], breaks: SWITCHES[name] }]));
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('Body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

// Separate pool so auditing still works while db-down replaces the app's pool.
export function createAuditStore(databaseUrl) {
  const auditPool = new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
  // Idle connection errors are harmless; the next query reconnects.
  auditPool.on('error', () => {});
  return {
    async rows() {
      const { rows } = await untraced(() =>
        auditPool.query('SELECT switch, enabled FROM chaos_audit ORDER BY created_at, id'),
      );
      return rows;
    },
    async record(name, enabled, actor) {
      await untraced(() =>
        auditPool.query('INSERT INTO chaos_audit (switch, enabled, actor) VALUES ($1, $2, $3)', [name, enabled, actor]),
      );
    },
  };
}

export function createControlServer({ token, audit }) {
  return http.createServer(async (req, res) => {
    try {
      if (!tokenMatches(req.headers.authorization, token)) {
        return send(res, 401, { error: 'Missing or wrong token (Authorization: Bearer <CHAOS_TOKEN>)' });
      }
      const url = new URL(req.url, 'http://chaos');

      if (req.method === 'GET' && url.pathname === '/chaos') {
        return send(res, 200, { switches: describe() });
      }

      const match = url.pathname.match(/^\/chaos\/([a-z-]+)$/);
      if (req.method === 'POST' && match) {
        const name = match[1];
        if (!isSwitch(name)) {
          return send(res, 404, { error: `No switch called "${name}"`, switches: SWITCH_NAMES });
        }
        const body = await readJson(req);
        if (typeof body.on !== 'boolean') {
          return send(res, 400, { error: 'Send { "on": true } or { "on": false }' });
        }
        const actor = String(body.actor ?? '').trim().slice(0, 60) || 'unknown';

        const changed = await setSwitch(name, body.on);
        let audited = true;
        try {
          await audit.record(name, body.on, actor);
        } catch {
          // The switch still changes; the response reports audited: false.
          audited = false;
        }
        return send(res, 200, { switch: name, on: body.on, changed, audited, switches: describe() });
      }

      return send(res, 404, { error: 'Not found. Use GET /chaos or POST /chaos/<switch>' });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  });
}

// Disabled unless CHAOS_TOKEN is set. Restores switch state from chaos_audit.
export async function startChaosControl() {
  const { token, port } = config.chaos;
  if (!token) return;

  const audit = createAuditStore(config.databaseUrl);
  try {
    for (const name of latestStates(await audit.rows())) await setSwitch(name, true);
  } catch {
    // History unreadable: start with every switch off.
  }

  const server = createControlServer({ token, audit });
  server.on('error', (err) => logger.warn({ event: 'admin.listen_failed', port, err }, 'Internal admin endpoint could not start'));
  server.listen(port, '127.0.0.1', () => {
    logger.info({ event: 'admin.listening', port }, `Internal admin endpoint listening on 127.0.0.1:${port}`);
  });
}
