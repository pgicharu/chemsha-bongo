-- 003: attempts by quiz_id (results, CSV export); 001's partial indexes don't cover live rows.
CREATE INDEX attempts_quiz_idx ON attempts (quiz_id);
