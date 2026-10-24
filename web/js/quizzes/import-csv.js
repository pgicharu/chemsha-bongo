// Parses quiz questions from CSV for the editor's import. Pure functions, tested in
// test/import-csv.test.js. Format (header row, one question per row):
//
//   question,answer_a,answer_b,answer_c,answer_d,correct,time_limit
//
// Headers: any order and case, spaces for underscores; time_limit is optional.
// Accepts a BOM (Excel "CSV UTF-8"), \r\n or \n, and ; as delimiter (some Excel locales).
// Lengths and ranges are left to the server, which reports them per field.

export const TEMPLATE_COLUMNS = ['question', 'answer_a', 'answer_b', 'answer_c', 'answer_d', 'correct', 'time_limit'];
const REQUIRED = TEMPLATE_COLUMNS.filter((column) => column !== 'time_limit');
const LETTERS = ['A', 'B', 'C', 'D'];

// Cap on reported problems; beyond this the file is probably not a quiz CSV.
const MAX_ERRORS = 10;

// RFC 4180: quoted cells may contain the delimiter, line breaks and "" for a quote.
export function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// "Answer A" → "answer_a"
function columnName(header) {
  return header.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// Returns { questions } or { errors }. All or nothing: any problem imports no questions.
export function questionsFromCsv(text, { maxQuestions = 50, defaultTimeLimit = 20 } = {}) {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0];
  const delimiter = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';

  const isBlank = (row) => row.every((cell) => cell.trim() === '');
  const [header, ...rows] = parseCsv(clean, delimiter).filter((row) => !isBlank(row));
  if (!header) return { errors: ['The file is empty.'] };

  const columns = header.map(columnName);
  const missing = REQUIRED.filter((column) => !columns.includes(column));
  if (missing.length > 0) {
    return {
      errors: [`The first row must name the columns. Missing: ${missing.join(', ')}. Download the template to see the layout.`],
    };
  }
  if (rows.length === 0) return { errors: ['The file has a header row but no questions.'] };
  if (rows.length > maxQuestions) {
    return { errors: [`The quiz has room for ${maxQuestions} more questions; the file has ${rows.length}.`] };
  }

  const errors = [];
  const questions = rows.map((row, i) => {
    const line = `Row ${i + 2}`; // the header is row 1, as in a spreadsheet
    const get = (column) => (row[columns.indexOf(column)] ?? '').trim();

    const prompt = get('question');
    if (prompt === '') errors.push(`${line}: the question is empty.`);

    const correct = get('correct').toUpperCase();
    if (!LETTERS.includes(correct)) {
      errors.push(`${line}: "correct" must be A, B, C or D${correct ? ` (it is "${get('correct')}")` : ''}.`);
    }

    return {
      prompt,
      options: { A: get('answer_a'), B: get('answer_b'), C: get('answer_c'), D: get('answer_d') },
      correct_option: LETTERS.includes(correct) ? correct : null,
      time_limit_seconds: get('time_limit') || String(defaultTimeLimit),
    };
  });

  if (errors.length > MAX_ERRORS) {
    return { errors: [...errors.slice(0, MAX_ERRORS), `…and ${errors.length - MAX_ERRORS} more.`] };
  }
  return errors.length > 0 ? { errors } : { questions };
}
