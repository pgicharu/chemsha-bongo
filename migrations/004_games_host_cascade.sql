-- 004: deleting a user also deletes the games they hosted (the host is the
-- quiz owner, whose quizzes are deleted anyway).

ALTER TABLE games DROP CONSTRAINT games_host_id_fkey;
ALTER TABLE games
  ADD CONSTRAINT games_host_id_fkey FOREIGN KEY (host_id) REFERENCES users (id) ON DELETE CASCADE;
