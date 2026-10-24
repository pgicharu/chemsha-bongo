-- 001: core schema.

CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text        NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  email         text        NOT NULL,
  password_hash text        NOT NULL,
  -- DiceBear options, not an image (see src/avatars.js).
  avatar        jsonb       NOT NULL DEFAULT '{}',
  -- Excluded from results and CSV exports.
  is_bot        boolean     NOT NULL DEFAULT false,
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

-- Only token hashes are stored, so a database leak yields no working links.
CREATE TABLE email_tokens (
  token_hash text        PRIMARY KEY,
  user_id    bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose    text        NOT NULL CHECK (purpose IN ('confirm', 'reset')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Shape required by connect-pg-simple.
CREATE TABLE session (
  sid    varchar      PRIMARY KEY,
  sess   json         NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX session_expire_idx ON session (expire);

CREATE TABLE quizzes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id   bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      text        NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  mode       text        NOT NULL CHECK (mode IN ('live', 'self_paced')),
  -- Self-paced only; attempts after this are refused.
  due_at     timestamptz,
  share_slug text        NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quizzes_owner_idx ON quizzes (owner_id);

CREATE TABLE questions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quiz_id            bigint  NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE,
  position           integer NOT NULL,
  prompt             text    NOT NULL CHECK (length(prompt) BETWEEN 1 AND 300),
  option_a           text    NOT NULL,
  option_b           text    NOT NULL,
  option_c           text    NOT NULL,
  option_d           text    NOT NULL,
  correct_option     char(1) NOT NULL CHECK (correct_option IN ('A', 'B', 'C', 'D')),
  time_limit_seconds integer NOT NULL DEFAULT 20 CHECK (time_limit_seconds BETWEEN 5 AND 120),
  UNIQUE (quiz_id, position)
);

CREATE TABLE games (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quiz_id    bigint      NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE,
  host_id    bigint      NOT NULL REFERENCES users (id),
  code       char(6)     NOT NULL,
  -- 'abandoned' = the server stopped mid-game.
  status     text        NOT NULL DEFAULT 'lobby'
             CHECK (status IN ('lobby', 'running', 'finished', 'abandoned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at   timestamptz
);
-- Codes are reused once a game is closed.
CREATE UNIQUE INDEX games_open_code_unique ON games (code) WHERE status IN ('lobby', 'running');

CREATE TABLE attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  quiz_id       bigint      NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE,
  game_id       bigint      REFERENCES games (id) ON DELETE CASCADE,  -- NULL = self-paced
  score         integer     NOT NULL DEFAULT 0,
  correct_count integer     NOT NULL DEFAULT 0,
  rank          integer,
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE UNIQUE INDEX attempts_live_unique ON attempts (game_id, user_id) WHERE game_id IS NOT NULL;
CREATE UNIQUE INDEX attempts_self_paced_unique ON attempts (quiz_id, user_id) WHERE game_id IS NULL;

-- Late answers and timings are kept so results can be re-scored if needed.
CREATE TABLE answers (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id     bigint      NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  question_id    bigint      NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  question_no    integer     NOT NULL,
  chosen_option  char(1)     CHECK (chosen_option IN ('A', 'B', 'C', 'D')),
  -- 'none' = no answer before the timer ran out.
  result         text        NOT NULL CHECK (result IN ('correct', 'wrong', 'late', 'none')),
  points         integer     NOT NULL DEFAULT 0,
  shown_at       timestamptz NOT NULL,
  deadline_at    timestamptz NOT NULL,
  received_at    timestamptz,
  UNIQUE (attempt_id, question_id)
);

-- Fault-injection audit trail; deliberately not in metrics or normal logs.
CREATE TABLE chaos_audit (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  switch     text        NOT NULL,
  enabled    boolean     NOT NULL,
  actor      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
