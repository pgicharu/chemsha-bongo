// Read-only Postgres role for Grafana (`grafana_reader`).
//
// SELECT only on an explicit list of tables, and only non-sensitive columns
// of users. No access to emails, password hashes, sessions, tokens or
// chaos_audit, nor to tables added later. Not a migration because the
// password (GRAFANA_DB_PASSWORD) must not be committed; runs idempotently at
// every start. Skipped when the password is empty.

import { escapeIdentifier, escapeLiteral } from 'pg';
import { config } from './config.js';
import { transaction } from './db.js';
import { logger } from './logger.js';
import { untraced } from './chaos/untraced.js';

const ROLE = 'grafana_reader';

const READABLE_TABLES = ['quizzes', 'questions', 'games', 'attempts', 'answers'];

// Deliberately excludes email, password_hash and avatar.
const READABLE_USER_COLUMNS = ['id', 'name', 'is_bot', 'confirmed_at', 'created_at'];

export async function ensureGrafanaReader() {
  const password = config.grafanaDbPassword;
  if (!password) {
    logger.info(
      { event: 'db.grafana_reader_skipped' },
      'GRAFANA_DB_PASSWORD is empty: not creating the read-only grafana_reader role',
    );
    return;
  }

  const role = escapeIdentifier(ROLE);

  await transaction(async (client) => {
    // Serialises concurrent starts so only one runs CREATE ROLE.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('grafana_reader'))");

    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);
    if (rowCount === 0) {
      await client.query(`CREATE ROLE ${role}`);
    }

    // ALTER ROLE cannot take parameters, so the password is in the SQL text;
    // run untraced so the pg instrumentation does not record it in a span.
    await untraced(() =>
      client.query(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
                    PASSWORD ${escapeLiteral(password)} CONNECTION LIMIT 5`),
    );

    // Read-only sessions and a timeout for runaway dashboard queries.
    await client.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
    await client.query(`ALTER ROLE ${role} SET statement_timeout = '10s'`);

    const { rows } = await client.query('SELECT current_database() AS db');
    await client.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(rows[0].db)} TO ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);

    // Revoke first so tables removed from the list lose their grant.
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);
    await client.query(`GRANT SELECT ON ${READABLE_TABLES.join(', ')} TO ${role}`);
    await client.query(`GRANT SELECT (${READABLE_USER_COLUMNS.join(', ')}) ON users TO ${role}`);

    // Already the default; explicit so the intent shows in \ddp.
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${role}`);
  });

  logger.info({ event: 'db.grafana_reader_ready' }, 'Read-only grafana_reader role is ready');
}
