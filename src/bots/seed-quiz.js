// The "Observability warm-up" quizzes the auto-host plays. Created through the
// normal API on first use, so they pass the same validation as any quiz.

import { query } from '../db.js';
import { apiRequest, apiError } from './http.js';

const LIVE_TITLE = 'Observability warm-up';
const SELF_PACED_TITLE = 'Observability warm-up (self-paced)';

const q = (prompt, [A, B, C, D], correct_option, time_limit_seconds = 20) => ({
  prompt,
  options: { A, B, C, D },
  correct_option,
  time_limit_seconds,
});

const WARM_UP_QUESTIONS = [
  q(
    'Which signal best answers "how many requests per second is the app serving right now?"',
    ['Metrics', 'Logs', 'Traces', 'Health checks'],
    'A',
    15,
  ),
  q(
    'How does Prometheus normally get metrics from an app?',
    ['The app pushes them to Prometheus', 'Prometheus scrapes (pulls) /metrics on a schedule', 'Prometheus reads the log files', 'Grafana forwards them'],
    'B',
    15,
  ),
  q(
    'Why record request latency in a histogram rather than as an average?',
    ['It uses less memory', 'Prometheus cannot store averages', 'Histograms never reset', 'You can work out percentiles such as p95'],
    'D',
  ),
  q('Which of these is a BAD label for a Prometheus metric?', ['method', 'status_code', 'user_id', 'route'], 'C', 15),
  q(
    'What makes a good Loki label?',
    ['Every field in the log line', 'A few low-cardinality values, like service and level', 'The trace id', 'The whole message'],
    'B',
  ),
  q('In tracing, what is a span?', ['One timed operation inside a trace', 'A single log line', 'A Prometheus time series', 'A Grafana panel'], 'A', 15),
  q('What links a log line to the trace it belongs to?', ['The timestamp', 'The hostname', 'The log level', 'The trace_id'], 'D', 15),
  q(
    'A good /health endpoint ...',
    ['Always answers 200', 'Returns every metric', 'Answers 200 only when the app can do its job', 'Requires a login'],
    'C',
  ),
  q('An SLO of 99.9% availability over 30 days allows about how much downtime?', ['43 minutes', '4 hours', '7 hours', '3 minutes'], 'A'),
  q(
    'Which of these is a counter, not a gauge?',
    ['Memory in use', 'Players connected right now', 'Answers received since the app started', 'Jobs waiting in a queue'],
    'C',
    15,
  ),
];

async function createQuiz(baseUrl, hostCookie, title, mode) {
  const reply = await apiRequest(baseUrl, hostCookie, 'POST', '/api/quizzes', { title, mode, questions: WARM_UP_QUESTIONS });
  if (!reply.ok) throw apiError(`Creating the quiz "${title}"`, reply);
  return reply.data; // { id, share_slug }
}

export async function ensureLiveQuiz({ baseUrl, host, hostCookie }) {
  const { rows } = await query(
    `SELECT id FROM quizzes WHERE owner_id = $1 AND title = $2 AND mode = 'live' ORDER BY id LIMIT 1`,
    [host.id, LIVE_TITLE],
  );
  if (rows[0]) return rows[0].id;
  return (await createQuiz(baseUrl, hostCookie, LIVE_TITLE, 'live')).id;
}

// Each bot can take a self-paced quiz once, so a new numbered copy is created
// when fewer than `botsNeeded` bots are left who have not taken the newest one.
export async function ensureSelfPacedQuiz({ baseUrl, host, hostCookie, botsNeeded, botCount }) {
  const { rows } = await query(
    `SELECT z.share_slug,
            (SELECT count(*) FROM attempts a WHERE a.quiz_id = z.id AND a.game_id IS NULL)::int AS taken,
            (SELECT count(*) FROM quizzes WHERE owner_id = $1 AND mode = 'self_paced' AND title LIKE $2 || '%')::int AS copies
       FROM quizzes z
      WHERE z.owner_id = $1 AND z.mode = 'self_paced' AND z.title LIKE $2 || '%'
      ORDER BY z.id DESC LIMIT 1`,
    [host.id, SELF_PACED_TITLE],
  );
  const newest = rows[0];
  if (newest && botCount - newest.taken >= botsNeeded) return newest.share_slug;

  const title = newest ? `${SELF_PACED_TITLE} #${newest.copies + 1}` : SELF_PACED_TITLE;
  return (await createQuiz(baseUrl, hostCookie, title, 'self_paced')).share_slug;
}
