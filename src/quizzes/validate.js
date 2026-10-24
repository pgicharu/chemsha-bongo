// Quiz validation. Never throws: returns { quiz } or { errors: [{ field, message }] }.
// The database CHECK constraints mirror these limits as a backstop.

export const LIMITS = {
  titleMax: 120,
  questionsMin: 1,
  questionsMax: 50,
  promptMax: 300,
  optionMax: 120,
  timeLimitMin: 5,
  timeLimitMax: 120,
  timeLimitDefault: 20,
};

export const MODES = ['live', 'self_paced'];
export const OPTION_LETTERS = ['A', 'B', 'C', 'D'];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// An unchanged currentDueAt is accepted even if past, so closed quizzes stay editable.
export function validateQuiz(body, { now = new Date(), currentDueAt = null } = {}) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });

  if (body === null || typeof body !== 'object') {
    return { errors: [{ field: 'quiz', message: 'Send the quiz as a JSON object' }] };
  }

  const title = text(body.title);
  if (title.length === 0) {
    fail('title', 'Give your quiz a title');
  } else if (title.length > LIMITS.titleMax) {
    fail('title', `Keep the title to ${LIMITS.titleMax} characters or fewer (it has ${title.length})`);
  }

  const mode = body.mode;
  if (!MODES.includes(mode)) {
    fail('mode', 'Choose live or self-paced');
  }

  let dueAt = null;
  const rawDueAt = body.due_at ?? null;
  if (rawDueAt !== null && rawDueAt !== '') {
    const parsed = new Date(rawDueAt);
    const unchanged = currentDueAt !== null && parsed.getTime() === new Date(currentDueAt).getTime();
    if (mode !== 'self_paced') {
      fail('due_at', 'Only self-paced quizzes can have a due date');
    } else if (typeof rawDueAt !== 'string' || Number.isNaN(parsed.getTime())) {
      fail('due_at', 'The due date is not a valid date and time');
    } else if (parsed <= now && !unchanged) {
      fail('due_at', 'The due date must be in the future');
    } else {
      dueAt = parsed;
    }
  }

  const questions = [];
  const rawQuestions = Array.isArray(body.questions) ? body.questions : null;

  if (rawQuestions === null || rawQuestions.length < LIMITS.questionsMin) {
    fail('questions', 'Add at least one question');
  } else if (rawQuestions.length > LIMITS.questionsMax) {
    fail('questions', `A quiz can have at most ${LIMITS.questionsMax} questions (this one has ${rawQuestions.length})`);
  } else {
    rawQuestions.forEach((raw, i) => {
      const where = `questions.${i}`;
      const label = `Question ${i + 1}`;
      const q = raw !== null && typeof raw === 'object' ? raw : {};

      const prompt = text(q.prompt);
      if (prompt.length === 0) {
        fail(`${where}.prompt`, `${label}: write the question`);
      } else if (prompt.length > LIMITS.promptMax) {
        fail(`${where}.prompt`, `${label}: keep the question to ${LIMITS.promptMax} characters or fewer (it has ${prompt.length})`);
      }

      const rawOptions = q.options !== null && typeof q.options === 'object' ? q.options : {};
      const options = {};
      for (const letter of OPTION_LETTERS) {
        const option = text(rawOptions[letter]);
        if (option.length === 0) {
          fail(`${where}.options.${letter}`, `${label}: option ${letter} is empty`);
        } else if (option.length > LIMITS.optionMax) {
          fail(`${where}.options.${letter}`, `${label}: keep option ${letter} to ${LIMITS.optionMax} characters or fewer`);
        }
        options[letter] = option;
      }

      const correct = q.correct_option;
      if (!OPTION_LETTERS.includes(correct)) {
        fail(`${where}.correct_option`, `${label}: mark which option is correct`);
      }

      // Missing or empty means the default.
      let timeLimit = LIMITS.timeLimitDefault;
      const rawTime = q.time_limit_seconds;
      if (rawTime !== undefined && rawTime !== null && rawTime !== '') {
        timeLimit = Number(rawTime);
        if (!Number.isInteger(timeLimit) || timeLimit < LIMITS.timeLimitMin || timeLimit > LIMITS.timeLimitMax) {
          fail(
            `${where}.time_limit_seconds`,
            `${label}: the time limit must be a whole number from ${LIMITS.timeLimitMin} to ${LIMITS.timeLimitMax} seconds`,
          );
        }
      }

      questions.push({ prompt, options, correct_option: correct, time_limit_seconds: timeLimit });
    });
  }

  if (errors.length > 0) return { errors };
  return { quiz: { title, mode, due_at: dueAt, questions } };
}
