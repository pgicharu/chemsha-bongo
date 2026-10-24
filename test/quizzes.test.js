// Tests for quiz validation and the results CSV (src/quizzes/); no database.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { csvCell, toCsv, csvFilename } from '../src/quizzes/csv.js';
import { validateQuiz, LIMITS } from '../src/quizzes/validate.js';

test('csvCell: commas, quotes and newlines are quoted (RFC 4180)', () => {
  assert.equal(csvCell('Wanjiru'), 'Wanjiru');
  assert.equal(csvCell('Otieno, Brian'), '"Otieno, Brian"');
  assert.equal(csvCell('The "Boss"'), '"The ""Boss"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
});

test('csvCell: cells a spreadsheet would run as a formula get a leading quote', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+254700000000'), "'+254700000000");
  assert.equal(csvCell('-Kamau'), "'-Kamau");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('\t=1+1'), "'\t=1+1");
  assert.equal(csvCell('=HYPERLINK("http://evil.example","Click")'), `"'=HYPERLINK(""http://evil.example"",""Click"")"`);
});

test('csvCell: numbers as they are, dates as ISO, empty for null', () => {
  assert.equal(csvCell(-5), '-5');
  assert.equal(csvCell(1000), '1000');
  assert.equal(csvCell(new Date('2026-10-21T08:30:00Z')), '2026-10-21T08:30:00.000Z');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});

test('toCsv: BOM first, header row, CRLF line ends', () => {
  const csv = toCsv(['name', 'score'], [['Akinyi', 900], ['Otieno, Brian', null]]);
  assert.equal(csv, '﻿name,score\r\nAkinyi,900\r\n"Otieno, Brian",\r\n');
});

test('csvFilename: only lowercase letters, digits and dashes', () => {
  const day = new Date('2026-10-21T12:00:00Z');
  assert.equal(csvFilename('Kenyan Capitals!', day), 'kenyan-capitals-results-2026-10-21.csv');
  assert.equal(csvFilename('Café "quiz" ../../etc', day), 'cafe-quiz-etc-results-2026-10-21.csv');
  assert.equal(csvFilename('!!!', day), 'quiz-results-2026-10-21.csv');
  assert.ok(csvFilename('a'.repeat(200), day).startsWith(`${'a'.repeat(50)}-results`));
});

const question = (overrides = {}) => ({
  prompt: 'Capital of Kenya?',
  options: { A: 'Mombasa', B: 'Nairobi', C: 'Kisumu', D: 'Nakuru' },
  correct_option: 'B',
  ...overrides,
});
const fields = (result) => result.errors.map((e) => e.field);
const now = new Date('2026-10-21T12:00:00Z');

test('validateQuiz: a good quiz comes back trimmed, with the default time limit', () => {
  const { quiz, errors } = validateQuiz({ title: '  Capitals  ', mode: 'live', questions: [question({ prompt: ' Capital of Kenya? ' })] });
  assert.equal(errors, undefined);
  assert.equal(quiz.title, 'Capitals');
  assert.equal(quiz.due_at, null);
  assert.equal(quiz.questions[0].prompt, 'Capital of Kenya?');
  assert.equal(quiz.questions[0].time_limit_seconds, LIMITS.timeLimitDefault);
});

test('validateQuiz: one error per problem, naming the field', () => {
  const result = validateQuiz({
    title: '',
    mode: 'party',
    questions: [question({ options: { A: 'x', B: '', C: 'y', D: 'z' }, correct_option: 'E', time_limit_seconds: 2.5 })],
  });
  assert.deepEqual(fields(result).sort(), [
    'mode',
    'questions.0.correct_option',
    'questions.0.options.B',
    'questions.0.time_limit_seconds',
    'title',
  ]);
  assert.deepEqual(fields(validateQuiz(null)), ['quiz']);
  assert.deepEqual(fields(validateQuiz({ title: 'T', mode: 'live', questions: [] })), ['questions']);
  const tooMany = Array.from({ length: LIMITS.questionsMax + 1 }, () => question());
  assert.deepEqual(fields(validateQuiz({ title: 'T', mode: 'live', questions: tooMany })), ['questions']);
});

test('validateQuiz: due dates only for self-paced, and only in the future', () => {
  const base = { title: 'T', questions: [question()] };
  const future = '2026-11-01T00:00:00Z';
  const past = '2026-10-01T00:00:00Z';
  assert.deepEqual(fields(validateQuiz({ ...base, mode: 'live', due_at: future }, { now })), ['due_at']);
  assert.deepEqual(fields(validateQuiz({ ...base, mode: 'self_paced', due_at: past }, { now })), ['due_at']);
  assert.deepEqual(fields(validateQuiz({ ...base, mode: 'self_paced', due_at: 'soon' }, { now })), ['due_at']);
  assert.equal(validateQuiz({ ...base, mode: 'self_paced', due_at: future }, { now }).quiz.due_at.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.ok(validateQuiz({ ...base, mode: 'self_paced', due_at: past }, { now, currentDueAt: new Date(past) }).quiz);
});
