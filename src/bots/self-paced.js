// Bots taking a self-paced quiz through the same HTTP API as web/take.html.
// A skipped question is left to run out; the next /question call closes it as 'none'.

import { setTimeout as sleep } from 'node:timers/promises';
import { query } from '../db.js';
import { LATE_GRACE_MS } from '../game/scoring.js';
import { planAnswer, chooseOption, correctLetterFor, randomMs } from './behaviour.js';
import { ensureBotPlayers, shuffled } from './accounts.js';
import { createBotSession, deleteBotSessions } from './sessions.js';
import { quizAnswerKey } from './answer-key.js';
import { apiRequest, apiError } from './http.js';
import { quietLog } from './live-player.js';

// Returns { status: 'finished', results, score } or { status: 'already_taken' }.
async function takeSelfPacedQuiz({ baseUrl, slug, cookie, answerKey, name, log = quietLog, signal }) {
  const call = (path, body) => apiRequest(baseUrl, cookie, 'POST', `/api/play/${slug}/${path}`, body ?? {});

  const start = await call('start');
  if (start.status === 409 && start.data?.code === 'already_taken') return { status: 'already_taken' };
  if (!start.ok) throw apiError(`${name}: start`, start);

  const results = { correct: 0, wrong: 0, late: 0, none: 0 };
  for (;;) {
    const asked = await call('question');
    if (!asked.ok) throw apiError(`${name}: question`, asked);
    const question = asked.data;
    if (question.finished) {
      results.none = question.total - results.correct - results.wrong - results.late;
      log.info(`${name} finished "${slug}": ${question.correctCount}/${question.total} right, ${question.score} points`);
      return { status: 'finished', results, score: question.score };
    }

    const plan = planAnswer({ remainingMs: question.remainingMs });
    if (plan.kind === 'skip') {
      await sleep(question.remainingMs + LATE_GRACE_MS + 200, undefined, { signal });
      continue;
    }

    await sleep(plan.delayMs, undefined, { signal });
    const option = chooseOption({ correctLetter: correctLetterFor(answerKey, question), correct: plan.correct });
    const answered = await call('answer', { questionNo: question.questionNo, option });
    if (!answered.ok) throw apiError(`${name}: answer to question ${question.questionNo}`, answered);
    results[answered.data.result] += 1;
  }
}

async function botsWithoutAttempt(slug, count) {
  const bots = await ensureBotPlayers();
  const { rows } = await query(
    `SELECT a.user_id FROM attempts a JOIN quizzes z ON z.id = a.quiz_id
      WHERE z.share_slug = $1 AND a.game_id IS NULL`,
    [slug],
  );
  const taken = new Set(rows.map((r) => String(r.user_id)));
  return shuffled(bots.filter((b) => !taken.has(String(b.id)))).slice(0, count);
}

// Start times are spread over `spreadMs`; bots that already took the quiz are skipped.
export async function runSelfPacedBots({ baseUrl, slug, count, spreadMs = 15_000, log = quietLog, signal }) {
  const answerKey = await quizAnswerKey(slug);
  if (answerKey.length === 0) throw new Error(`There is no quiz with the share link ${slug}`);

  const accounts = await botsWithoutAttempt(slug, count);
  const sessions = await Promise.all(accounts.map((a) => createBotSession(a.id)));
  const totals = { bots: 0, correct: 0, wrong: 0, late: 0, none: 0 };
  try {
    await Promise.all(
      accounts.map(async (account, i) => {
        try {
          await sleep(randomMs(0, spreadMs), undefined, { signal });
          const outcome = await takeSelfPacedQuiz({
            baseUrl,
            slug,
            cookie: sessions[i].cookie,
            answerKey,
            name: account.name,
            log,
            signal,
          });
          if (outcome.status !== 'finished') return;
          totals.bots += 1;
          for (const [result, n] of Object.entries(outcome.results)) totals[result] += n;
        } catch (err) {
          if (err.name !== 'AbortError') log.warn(err.message);
        }
      }),
    );
  } finally {
    await deleteBotSessions(sessions.map((s) => s.sid));
  }
  return totals;
}
