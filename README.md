# Chemsha Bongo

A Kahoot-style quiz app with a full observability stack around it.

- **Live games**: the host shows a 6-digit code and a QR code of the join
  link; players join on their phones and race to answer.
- **Self-paced quizzes**: players take them from a link (`/q/<code>`), one
  attempt each, before an optional due date.
- **CSV import** of questions, with a downloadable template, and CSV export
  of results.
- **Avatars**, bot players for test traffic, and re-scoring from stored
  answer times.
- **Observability**: Prometheus metrics, logs shipped to Loki by Alloy,
  OpenTelemetry traces in Tempo, Grafana, Uptime Kuma and Netdata.
- **Chaos switches**: fault injection for practising incident response.

Node.js 24, Express 5, Socket.IO, Postgres 18, a Vite front end, Docker
Compose. See [ARCHITECTURE.md](ARCHITECTURE.md) for how it fits together and
[DEPLOY.md](DEPLOY.md) for running it on a server.

## Requirements

- Docker with Compose v2 (Docker Desktop: give it at least 4 GB of memory)
- `make` (on Windows, use WSL2) and Git
- About 4 GB of free memory and 15 GB of free disk (the images take about
  10 GB)

## Quick start

```sh
git clone <repo-url> chemsha-bongo
cd chemsha-bongo
make up                                  # creates .env from .env.example, builds, starts
make ps                                  # every service running
curl http://localhost:3000/health        # {"status":"ok"}
make traffic-up                          # optional: bots play games in a loop
```

`make pull` downloads every image ahead of time. Settings live in `.env`;
every variable is described in [.env.example](.env.example). After editing
`.env`, run `make up` again (`make restart` does not re-read it).

| What | Address | Login |
| --- | --- | --- |
| App | <http://localhost:3000> | an app account |
| Grafana | <http://localhost:3001> | none needed; `admin` / `admin` also works |
| Uptime Kuma | <http://localhost:3002> | create an admin account on the first visit |
| Prometheus | <http://localhost:9090> | none |
| Alloy | <http://localhost:12345> | none |
| Netdata | <http://localhost:19999> | none |
| Mailpit (after `make mail-up`) | <http://localhost:8025> | none |

Monitoring pages listen on `127.0.0.1` only; the app (3000) is open to the
local network so phones can join.

### Signing up locally

Sign-up finishes when the confirmation link is opened; that link also logs
you in. With the default `EMAIL_TRANSPORT=log`, no email is sent: confirmation
and password-reset links are printed in the app's logs:

```sh
docker compose logs app | grep email.logged
```

For a real inbox, run `make mail-up`, set `EMAIL_TRANSPORT=smtp` in `.env`
(the `SMTP_*` defaults point at Mailpit) and run `make up`.

### Playing from a phone

Phones cannot reach `localhost`. Either open `http://<laptop IP>:3000` on the
same network, or run `make tunnel` for a public ngrok address. Set
`APP_BASE_URL` in `.env` to that address so email and join links use it, then
`make up`.

## Make targets

`make help` lists them all. Each is a single `docker compose` command.

| Target | What it does |
| --- | --- |
| `make up` / `make down` | Start (building as needed) / stop; data is kept |
| `make ps`, `make logs`, `make stats` | Container health, app logs, memory and CPU |
| `make urls` | Print every page and its address |
| `make psql` | SQL prompt on the database |
| `make traffic-up` / `traffic-down` | Start / stop continuous bot games |
| `make bots ARGS="--code 123456"` | Send bots into a live game (`--quiz <code>` for a self-paced one, `--help`) |
| `make mail-up` / `mail-down` | Start / stop Mailpit |
| `make tunnel` | Expose the app with ngrok |
| `make dashboards-up` | Start the stack with the reference Grafana dashboards |
| `make chaos ARGS=status` | Show or flip chaos switches |
| `make rescore ARGS="--quiz 12 --dry-run"` | Re-score a quiz from its stored answers |
| `make migrate` | Apply pending migrations (also done at start-up) |
| `make reset` | Stop everything and **delete all data** |

The `prod-*` targets are for the server; see [DEPLOY.md](DEPLOY.md).

## Scoring

A correct answer earns 1,000 points if instant, falling linearly to 500 at
the end of the timer; wrong or missing answers earn 0. The server keeps the
clock and allows one second of network grace; later answers are stored but
marked late. Rules: `src/game/scoring.js`.

`make rescore` recomputes a quiz's scores from the stored times with the
current rules. The quiz id is the number in the editor's address
(`/edit?id=12`).

## Bots

Bots are real accounts marked `is_bot`, so they never appear in results or
exports. They answer about 70% correctly at human-like speeds, skip a few,
and send about 5% of answers just too late. `make traffic-up` runs a service
that hosts a game, fills it with `TRAFFIC_BOTS` bots (default 15), plays it
through and repeats. `make bots ARGS="--code 123456 --count 50"` doubles as
a small load test. The lobby's **Add 5 bots** button appears only when
`ALLOW_BOTS=true`.

## Observability

| Service | Image | Role |
| --- | --- | --- |
| `app` | built from `Dockerfile` | serves `/metrics`, logs JSON to stdout, sends traces |
| `postgres` | `postgres:18.6` | database |
| `lgtm` | `grafana/otel-lgtm:0.36.0` | Grafana, Loki, Tempo, Prometheus and an OpenTelemetry collector in one container |
| `alloy` | `grafana/alloy:v1.20.1` | tails container log files and ships them to Loki |
| `uptime-kuma` | `louislam/uptime-kuma:2.5.6` | external availability checks and alerts |
| `netdata` | `netdata/netdata:v2.12.1` | per-second host and container charts |
| `mailpit` | `axllent/mailpit:v1.31.5` | optional local inbox |

- **Metrics**: Prometheus scrapes `http://app:3000/metrics` every 10 s
  (`observability/prometheus/prometheus.yaml`).
- **Logs**: the app writes one JSON object per line to stdout; Docker's
  json-file driver stores it, Alloy tails it and pushes to Loki
  (`observability/alloy/config.alloy`). Streams are labelled `service`,
  `container`, `stream` and `level`; high-cardinality fields (`event`,
  `trace_id`, `span_id`, `filename`) are structured metadata.
- **Traces**: OTLP over HTTP to `http://lgtm:4318`
  (`OTEL_EXPORTER_OTLP_ENDPOINT`), stored in Tempo as service
  `chemsha-bongo`.
- **Correlation**: log lines with a `trace_id` link to their trace, and spans
  link back to their logs (`observability/grafana/datasources.yaml`).
- **Postgres** is also a Grafana data source through `grafana_reader`, a
  read-only user the app creates at start-up (`src/grafana-reader.js`). It
  cannot read emails, password hashes, sessions, tokens or the chaos audit.
  Its password is `GRAFANA_DB_PASSWORD`.

Example queries in Grafana Explore:

```logql
{service="app", level="error"}
{service="app"} | event="answer.scored"
{service="app"} | json | game_id="12"
```

Prometheus: `chemsha_answers_total`. Tempo: search service `chemsha-bongo`.

Grafana starts with no dashboards. `make dashboards-up` loads two reference
dashboards from `dashboards/`: *operations* (RED metrics, players, games,
answers, scoring latency, socket disconnects, emails, process resources,
error logs) and *activity* (sign-ups, quizzes and attempts per day, from
Postgres). Plain `make up` removes them again.

Every container has a memory limit (`docker-compose.yml`); the whole stack
uses about 1.4 GiB with light traffic, most of it `lgtm`. To save memory,
`docker compose stop netdata uptime-kuma` (or `lgtm alloy` for the whole
monitoring side); the app keeps working. Docker rotates log files at 10 MB,
keeping 3.

On rootless Docker, set `DOCKER_CONTAINERS_DIR` and `DOCKER_SOCK` in `.env`
so Alloy can find the log files.

## Chaos switches

Six switches inject realistic faults so incidents can be diagnosed from the
telemetry: `crash`, `db-down`, `socket-storm`, `slow-scoring`,
`leaderboard-leak`, `email-down`. They are off by default and only work when
`CHAOS_TOKEN` is set in `.env` (e.g. `openssl rand -hex 24`, then `make up`).

```sh
make chaos ARGS=status
make chaos ARGS="slow-scoring on"
make chaos ARGS="all off"
```

Most faults only show while games are being played. The control port is
internal to the app container and must never be published or proxied.

## Tests

```sh
npm test
```
