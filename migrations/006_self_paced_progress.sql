-- 006: self-paced progress (last question served and when), persisted so a
-- player can resume; the deadline is current_shown_at + time limit. NULL for
-- live attempts, whose state is held in memory.

ALTER TABLE attempts
  ADD COLUMN current_question_no integer,
  ADD COLUMN current_shown_at    timestamptz;
