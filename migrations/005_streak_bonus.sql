-- 005: answer_history and player_streak_bonus(), used only by the
-- slow-scoring fault (src/chaos/). Intentionally slow: no index on
-- (player_id, quiz_id), plus pg_sleep to make each call take about 4 s.

CREATE TABLE answer_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id   bigint      NOT NULL,
  quiz_id     bigint      NOT NULL,
  correct     boolean     NOT NULL,
  answered_at timestamptz NOT NULL
);

-- Synthetic rows; ids do not match real users or quizzes.
INSERT INTO answer_history (player_id, quiz_id, correct, answered_at)
SELECT (random() * 5000)::bigint + 1,
       (random() * 500)::bigint + 1,
       random() < 0.7,
       now() - random() * interval '365 days'
FROM generate_series(1, 300000);

ANALYZE answer_history;

CREATE FUNCTION player_streak_bonus(p_player_id bigint, p_quiz_id bigint) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  started timestamptz := clock_timestamp();
  streak  integer;
BEGIN
  SELECT count(*) INTO streak
  FROM answer_history
  WHERE player_id = p_player_id
    AND quiz_id = p_quiz_id
    AND correct
    AND answered_at > now() - interval '30 days';

  -- Pads the call to about 4 s, simulating a much larger table.
  PERFORM pg_sleep(greatest(0, 4.0 - extract(epoch FROM clock_timestamp() - started)));

  RETURN least(streak, 5);
END;
$$;
