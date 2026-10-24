// Postgres connection pool plus query/transaction helpers.
// All SQL is parameterised ($1, $2, ...); never concatenate values.

import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

// `extra` is only used by the db-down fault (replacePool).
function createPool(extra = {}) {
  const newPool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 20,
    // Fail instead of hanging when Postgres is unreachable or the pool is exhausted.
    connectionTimeoutMillis: 5_000,
    ...extra,
  });
  // Without this, an idle connection error (e.g. Postgres restart) crashes the process.
  newPool.on('error', (err) => {
    logger.error({ event: 'db.pool_error', err }, 'Idle database connection failed');
  });
  return newPool;
}

let currentPool = createPool();

// Proxy to the current pg.Pool so replacePool() can swap it transparently.
export const pool = {
  query: (...args) => currentPool.query(...args),
  connect: (...args) => currentPool.connect(...args),
  end: () => currentPool.end(),
};

// Used by src/chaos/db-down.js. The old pool closes busy connections once released.
export function replacePool(extra) {
  const oldPool = currentPool;
  currentPool = createPool(extra);
  oldPool.end().catch(() => {});
}

export function query(text, params) {
  return pool.query(text, params);
}

// Runs work(client) inside BEGIN/COMMIT, rolling back on error.
export async function transaction(work) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // If the connection broke, ROLLBACK fails too; rethrow the original error.
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    // Destroy a broken connection rather than returning it to the pool.
    client.release(broken);
  }
}
