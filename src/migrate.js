// Migration runner: applies migrations/*.sql once each, in filename order,
// tracked in schema_migrations. Never edit an applied migration; add a new file.
// Runs at server start, or with `npm run migrate`.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, transaction } from './db.js';
import { logger } from './logger.js';
import { ensureGrafanaReader } from './grafana-reader.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.filename));

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await transaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    });
    logger.info({ event: 'db.migration_applied', file }, `Applied migration ${file}`);
  }

  // Not a migration because it needs a password (see grafana-reader.js).
  await ensureGrafanaReader();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ event: 'db.migration_failed', err }, 'Migration failed');
      process.exit(1);
    });
}
