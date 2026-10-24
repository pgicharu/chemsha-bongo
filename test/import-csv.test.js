// Tests for the CSV question import (web/js/quizzes/import-csv.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseCsv, questionsFromCsv } from '../web/js/quizzes/import-csv.js';

const HEADER = 'question,answer_a,answer_b,answer_c,answer_d,correct,time_limit';

test('parseCsv: quoted cells keep commas, line breaks and doubled quotes', () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi""","two\nlines"\r\nx,y\n'), [
    ['a', 'b, c', 'say "hi"', 'two\nlines'],
    ['x', 'y'],
  ]);
});

test('the downloadable template imports cleanly', () => {
  const template = readFileSync(new URL('../web/public/quiz-template.csv', import.meta.url), 'utf8');
  const { questions, errors } = questionsFromCsv(template);
  assert.equal(errors, undefined);
  assert.equal(questions.length, 3);
  assert.equal(questions[1].time_limit_seconds, '20');
  assert.equal(questions[2].prompt, 'A label like player_id on a metric causes high ___, so avoid it');
});

test('a row becomes an editor question; correct is case-insensitive', () => {
  const { questions } = questionsFromCsv(`${HEADER}\nWhich stores logs?, Loki ,Tempo,Prometheus,Alloy,a,15\n`);
  assert.deepEqual(questions, [
    {
      prompt: 'Which stores logs?',
      options: { A: 'Loki', B: 'Tempo', C: 'Prometheus', D: 'Alloy' },
      correct_option: 'A',
      time_limit_seconds: '15',
    },
  ]);
});

test('Excel variations: BOM, semicolons, headers with spaces in another order, no time_limit', () => {
  const text = '﻿Correct;Question;Answer A;Answer B;Answer C;Answer D\r\nD;Q1;a;b;c;d\r\n;;;;;\r\n';
  const { questions } = questionsFromCsv(text, { defaultTimeLimit: 20 });
  assert.equal(questions.length, 1);
  assert.equal(questions[0].correct_option, 'D');
  assert.equal(questions[0].time_limit_seconds, '20');
});

test('all or nothing: any bad row imports nothing and says which row', () => {
  const { questions, errors } = questionsFromCsv(`${HEADER}\nQ1,a,b,c,d,A,\n,a,b,c,d,E,\n`);
  assert.equal(questions, undefined);
  assert.deepEqual(errors, ['Row 3: the question is empty.', 'Row 3: "correct" must be A, B, C or D (it is "E").']);
});

test('missing columns, empty files and too many rows are refused', () => {
  assert.match(questionsFromCsv('question,answer_a\nQ,a\n').errors[0], /Missing: answer_b, answer_c, answer_d, correct/);
  assert.deepEqual(questionsFromCsv('').errors, ['The file is empty.']);
  assert.deepEqual(questionsFromCsv(`${HEADER}\n`).errors, ['The file has a header row but no questions.']);
  const rows = Array.from({ length: 3 }, (_, i) => `Q${i},a,b,c,d,A,`).join('\n');
  assert.match(questionsFromCsv(`${HEADER}\n${rows}`, { maxQuestions: 2 }).errors[0], /room for 2 more questions; the file has 3/);
});
