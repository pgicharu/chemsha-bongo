// Self-paced attempt rules: pure functions deciding what to serve next.

import { deadlineAtMs } from '../game/scoring.js';

// A duration, not a timestamp, so client clock skew does not matter.
export function remainingMs(shownAtMs, timeLimitSeconds, nowMs) {
  return Math.max(0, deadlineAtMs(shownAtMs, timeLimitSeconds) - nowMs);
}

export function isPastDue(dueAtMs, nowMs) {
  return dueAtMs !== null && nowMs >= dueAtMs;
}

// Returns { expire, next, questionNo, remainingMs }. `expire` is a question to
// close as 'none' first, or null; `next` is 'resume' | 'serve' | 'finished' | 'past_due'.
// Expiry ignores the network grace: asking for the next question means the
// player has stopped answering this one.
export function planNext({ total, servedNo, servedShownAtMs, servedTimeLimitSeconds, servedAnswered, dueAtMs, nowMs }) {
  let expire = null;

  if (servedNo > 0 && !servedAnswered) {
    const left = remainingMs(servedShownAtMs, servedTimeLimitSeconds, nowMs);
    if (left > 0) return { expire: null, next: 'resume', questionNo: servedNo, remainingMs: left };
    expire = servedNo;
  }

  if (servedNo >= total) return { expire, next: 'finished' };
  if (isPastDue(dueAtMs, nowMs)) return { expire, next: 'past_due' };
  return { expire, next: 'serve', questionNo: servedNo + 1 };
}
