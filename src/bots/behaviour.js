// Bot answering behaviour: pure functions taking an injectable `random` in [0, 1).
// A small share of answers is sent just past deadline + grace so `late`
// results have a steady baseline in the metrics.

import { LATE_GRACE_MS } from '../game/scoring.js';
import { OPTION_LETTERS as LETTERS } from '../quizzes/validate.js';

export const BEHAVIOUR = {
  accuracy: 0.7,
  lateShare: 0.05,
  skipShare: 0.03,
  // On-time answers leave this much margin so network delay can't make them late.
  safetyMarginMs: 400,
  // Late answers land this long after deadline + grace.
  lateByMs: [250, 1500],
};

function between(random, min, max) {
  return min + (max - min) * random();
}

// 10% quick, 80% in 2-10 s skewed early, 10% slow (capped later by planAnswer).
export function thinkTimeMs(random = Math.random) {
  const roll = random();
  if (roll < 0.1) return Math.round(between(random, 700, 2000));
  if (roll < 0.9) return Math.round(2000 + 8000 * random() ** 1.5);
  return Math.round(between(random, 10_000, 20_000));
}

// Returns { kind: 'answer' | 'late', delayMs, correct } or { kind: 'skip' }.
export function planAnswer({ remainingMs, random = Math.random, behaviour = BEHAVIOUR }) {
  const roll = random();
  const correct = random() < behaviour.accuracy;

  if (roll < behaviour.lateShare) {
    const [min, max] = behaviour.lateByMs;
    return { kind: 'late', delayMs: Math.round(remainingMs + LATE_GRACE_MS + between(random, min, max)), correct };
  }
  if (roll < behaviour.lateShare + behaviour.skipShare) return { kind: 'skip' };

  const latestMs = remainingMs - behaviour.safetyMarginMs;
  if (latestMs <= 0) return { kind: 'skip' };

  return { kind: 'answer', delayMs: Math.min(thinkTimeMs(random), latestMs), correct };
}

// With no known correctLetter, guesses.
export function chooseOption({ correctLetter, correct, random = Math.random }) {
  if (!correctLetter) return LETTERS[Math.floor(random() * LETTERS.length)];
  if (correct) return correctLetter;
  const wrong = LETTERS.filter((letter) => letter !== correctLetter);
  return wrong[Math.floor(random() * wrong.length)];
}

// Matches on prompt and option text, so it survives reordered options.
export function correctLetterFor(answerKey, { prompt, options }) {
  for (const entry of answerKey) {
    if (entry.prompt !== prompt) continue;
    const rightText = entry.options[entry.correctOption];
    const letter = LETTERS.find((l) => options?.[l] === rightText);
    if (letter) return letter;
  }
  return null;
}

export function randomMs(min, max, random = Math.random) {
  return Math.round(between(random, min, max));
}
