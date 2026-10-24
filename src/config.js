// Configuration from environment variables (documented in .env.example).
// The rest of the app reads `config`, never process.env.

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

function optional(name, fallback) {
  return process.env[name] ?? fallback;
}

// Accepts true/false, 1/0, yes/no; anything else throws.
function boolean(name, fallback) {
  const value = optional(name, String(fallback)).toLowerCase();
  if (['true', '1', 'yes'].includes(value)) return true;
  if (['false', '0', 'no', ''].includes(value)) return false;
  throw new Error(`Environment variable ${name} must be true or false`);
}

function integer(name, fallback) {
  const value = Number.parseInt(optional(name, String(fallback)), 10);
  if (Number.isNaN(value)) {
    throw new Error(`Environment variable ${name} must be a whole number`);
  }
  return value;
}

// Example values from .env.example; public, so rejected in production.
const EXAMPLE_SESSION_SECRET = 'change-me-to-a-long-random-string';
const EXAMPLE_GRAFANA_DB_PASSWORD = 'grafana-reader-local-only';
const MIN_SESSION_SECRET_LENGTH = 32;

// In production, refuses to start with an example or too-short secret.
// Exported for tests.
export function checkProductionSecrets({ env, sessionSecret, grafanaDbPassword }) {
  if (env !== 'production') return;
  const fix = 'Generate one with `openssl rand -hex 32` and put it in .env (see DEPLOY.md).';
  if (sessionSecret === EXAMPLE_SESSION_SECRET) {
    throw new Error(`SESSION_SECRET is still the example value from .env.example. ${fix}`);
  }
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters in production. ${fix}`);
  }
  if (grafanaDbPassword === EXAMPLE_GRAFANA_DB_PASSWORD) {
    throw new Error(`GRAFANA_DB_PASSWORD is still the example value from .env.example. ${fix}`);
  }
}

export const config = {
  // 'production' enables the secret checks above.
  env: optional('NODE_ENV', 'development'),
  port: integer('PORT', 3000),

  // Public base URL, used for links in emails.
  baseUrl: optional('APP_BASE_URL', 'http://localhost:3000'),

  databaseUrl: required('DATABASE_URL'),
  sessionSecret: required('SESSION_SECRET'),
  // Read-only Grafana database user; empty disables it (see grafana-reader.js).
  grafanaDbPassword: optional('GRAFANA_DB_PASSWORD', ''),

  logLevel: optional('LOG_LEVEL', 'info'),

  email: {
    // 'log' writes the email's link to the logs; 'smtp' sends via SMTP.
    transport: optional('EMAIL_TRANSPORT', 'log'),
    from: optional('MAIL_FROM', 'Chemsha Bongo <no-reply@chemsha.local>'),
    smtp: {
      host: optional('SMTP_HOST', 'localhost'),
      port: integer('SMTP_PORT', 1025),
      // true = implicit TLS (465); false = STARTTLS if offered (587, 1025).
      secure: boolean('SMTP_SECURE', false),
      user: optional('SMTP_USER', ''),
      pass: optional('SMTP_PASS', ''),
    },
  },

  // Fault injection (src/chaos/). The control server starts only when
  // CHAOS_TOKEN is set, binds 127.0.0.1, and must never be published or proxied.
  chaos: {
    token: optional('CHAOS_TOKEN', ''),
    port: integer('CHAOS_PORT', 9091),
  },

  // Bot players (src/bots/).
  bots: {
    // Enables "Add 5 bots" and POST /api/games/:id/bots. Off by default;
    // keep it off on public servers.
    allowed: boolean('ALLOW_BOTS', false),
    // Target for the bot CLI (npm run bots).
    url: optional('BOTS_URL', 'http://localhost:3000'),
  },

  // Built front end; override to run several copies side by side.
  webDir: optional('WEB_DIR', 'dist/web'),
};

checkProductionSecrets(config);
