// Correct answers for a quiz, read straight from the database. Bots are a test
// tool; real clients never see the correct option before the reveal.

import { query } from '../db.js';

function toKey(rows) {
  return rows.map((row) => ({
    prompt: row.prompt,
    options: { A: row.option_a, B: row.option_b, C: row.option_c, D: row.option_d },
    correctOption: row.correct_option,
  }));
}

const COLUMNS = 'q.prompt, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option';

export async function liveAnswerKey(code) {
  const { rows } = await query(
    `SELECT ${COLUMNS}
       FROM games g JOIN questions q ON q.quiz_id = g.quiz_id
      WHERE g.code = $1 AND g.status IN ('lobby', 'running')
      ORDER BY q.position`,
    [code],
  );
  return toKey(rows);
}

export async function quizAnswerKey(slug) {
  const { rows } = await query(
    `SELECT ${COLUMNS}
       FROM quizzes z JOIN questions q ON q.quiz_id = z.id
      WHERE z.share_slug = $1
      ORDER BY q.position`,
    [slug],
  );
  return toKey(rows);
}
