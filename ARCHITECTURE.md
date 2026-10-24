# Architecture

## Components

```
 browsers (host screen, players' phones)
          │  HTTP + WebSocket (Socket.IO)
          ▼
 ┌──────────────────────┐        ┌──────────────┐
 │  app  (Node.js 24)   │──SQL──▶│ Postgres 18  │
 │  Express + Socket.IO │        └──────────────┘
 └──────────────────────┘
          │ SMTP
          ▼
   Mailpit (local) / any SMTP provider (server)
```

- **Express** serves the pages (built by Vite into `dist/web`) and the JSON API.
- **Socket.IO** carries the real-time part of a live game: joining,
  questions, answers, the leaderboard.
- **Postgres** is the source of truth: users, quizzes, games, attempts and
  every answer. A live game's in-progress state is held in memory; if the
  app restarts mid-game, that game is marked `abandoned`.

## Code layout

| Path | Contents |
| --- | --- |
| `src/server.js` | Entry point: migrations, Express, Socket.IO, shutdown |
| `src/config.js` | All environment variables, read in one place |
| `src/logger.js` | pino logger and logging conventions |
| `src/db.js` | Connection pool, `query()` and `transaction()` helpers |
| `src/migrate.js` | Applies `migrations/*.sql` in order |
| `src/health.js` | `GET /health` (shallow) |
| `src/metrics.js` | Prometheus metrics, `GET /metrics`, HTTP timing |
| `src/tracing.js` | OpenTelemetry set-up, loaded first with `node --import` |
| `src/spans.js` | `inSpan()` helper for manual spans |
| `src/grafana-reader.js` | Creates `grafana_reader`, Grafana's read-only database user |
| `src/avatars.js` | Avatar options and validation (rendered in the browser) |
| `src/auth/` | Sign-up, confirmation, login, password reset, sessions, rate limits, Socket.IO auth |
| `src/email/` | `sendEmail()`, the single path for all email, and templates |
| `src/quizzes/` | Quiz API, validation, CSV import, results and CSV export |
| `src/game/` | Live games: `scoring.js` (pure rules), `engine.js` (state and persistence), `sockets.js` (realtime events, listed at the top) |
| `src/selfpaced/` | Self-paced quizzes over HTTP |
| `src/chaos/` | Fault-injection switches: state, internal control server, larger failure modes. Hooks elsewhere are marked `Chaos hook` |
| `src/bots/` | Bot players and auto-host, used by `scripts/bots.js` and the lobby's "Add bots" button |
| `scripts/` | CLIs: `bots.js`, `rescore.js`, `chaos.js` (`npm run bots|rescore|chaos`) |
| `migrations/` | Numbered plain-SQL schema changes |
| `test/` | Unit tests (`npm test`) |
| `web/` | Front end: one HTML file per page, CSS and JS per area |
| `observability/` | Prometheus, Alloy and Grafana data source config |
| `dashboards/` | Reference Grafana dashboards (`make dashboards-up`) |
| `deploy/` | Production: Caddyfile, backup and restore scripts ([DEPLOY.md](DEPLOY.md)) |

## Telemetry flow

```
app ── stdout (JSON logs) ──▶ Docker json-file ──▶ Alloy ──▶ Loki ─┐
app ◀── scrape /metrics every 10 s ── Prometheus ──────────────────┼──▶ Grafana
app ── OTLP traces ──────────▶ OpenTelemetry Collector ──▶ Tempo ─┘
Postgres ◀── read-only user ───────────────────────────────────────▶ Grafana
```

Prometheus, Loki, Tempo, the collector and Grafana run in the single
`grafana/otel-lgtm` container (`lgtm` in `docker-compose.yml`).

## Life of an answer

1. The host advances. The server records `shown_at`, sets
   `deadline_at = shown_at + time limit` and sends `question:show` with the
   time remaining.
2. A player picks an option; the client emits `player:answer`.
3. The server stamps the receive time and calls `scoreAndSaveAnswer()`
   (`src/game/engine.js`), which uses `judgeAnswer()` (`src/game/scoring.js`):
   - `isLate()`: after the deadline plus 1 s of network grace. Late answers
     score 0 but are stored.
   - `scoreAnswer()`: 1,000 points for a correct answer, falling linearly to
     500 at the deadline.
   - The answer row and the attempt total are saved in one transaction.
4. When time is up or everyone has answered, the server reveals the correct
   option and sends each player their result privately.

## Conventions

- **SQL** is plain and parameterised (`$1`, `$2`); no ORM.
- **Logs** are JSON, one event per line, with an `event` field such as
  `answer.scored`. Passwords, tokens and cookies are never logged.
- **Metric labels** never contain player names, emails, IDs or game codes.
- **Times** are decided by the server, never taken from the client.
- **Styling** uses only the CSS variables from `web/css/theme-*.css`.
