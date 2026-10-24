// Scoring and the answer deadline: pure functions over millisecond values.
// All times are server times (sent / received); the browser clock is never used.
// Live games, self-paced quizzes and scripts/rescore.js all judge answers here.

// Network slack after the deadline. Answers inside it score as if they arrived
// exactly at the deadline; anything later is `late`.
export const LATE_GRACE_MS = 1000;

export const MAX_POINTS = 1000;

// The time limit is stored in whole seconds.
export function deadlineAtMs(shownAtMs, timeLimitSeconds) {
  return shownAtMs + timeLimitSeconds * 1000;
}

// Arriving exactly at deadline + grace still counts.
export function isLate(receivedAtMs, deadlineAtMs) {
  return receivedAtMs > deadlineAtMs + LATE_GRACE_MS;
}

// Clamped to [0, timeLimitMs]: answers in the grace window count as at the deadline.
export function timeTakenMs(shownAtMs, receivedAtMs, timeLimitMs) {
  const taken = receivedAtMs - shownAtMs;
  return Math.min(Math.max(taken, 0), timeLimitMs);
}

// Correct: round(1000 × (1 − fractionUsed / 2)), i.e. 1000 instant down to 500
// at the deadline. Wrong or missing: 0.
export function scoreAnswer({ correct, timeTakenMs: taken, timeLimitMs }) {
  if (!correct) return 0;
  const fractionUsed = Math.min(Math.max(taken / timeLimitMs, 0), 1);
  return Math.round(MAX_POINTS * (1 - fractionUsed / 2));
}

// Returns { result: 'correct' | 'wrong' | 'late', points }.
export function judgeAnswer({ option, correctOption, shownAtMs, timeLimitSeconds, receivedAtMs }) {
  if (isLate(receivedAtMs, deadlineAtMs(shownAtMs, timeLimitSeconds))) {
    return { result: 'late', points: 0 };
  }
  const timeLimitMs = timeLimitSeconds * 1000;
  const correct = option === correctOption;
  const points = scoreAnswer({
    correct,
    timeTakenMs: timeTakenMs(shownAtMs, receivedAtMs, timeLimitMs),
    timeLimitMs,
  });
  return { result: correct ? 'correct' : 'wrong', points };
}

// Highest first; ties share a rank and the next is skipped ("1, 2, 2, 4").
// Returns a new array with `rank` added to each player.
export function rankByScore(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  let rank = 0;
  return sorted.map((player, index) => {
    if (index === 0 || player.score !== sorted[index - 1].score) {
      rank = index + 1;
    }
    return { ...player, rank };
  });
}
