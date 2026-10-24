-- 002: indexes for accounts.

-- Foreign keys are not indexed automatically in Postgres.
CREATE INDEX email_tokens_user_idx ON email_tokens (user_id, purpose);

-- For logging a user out everywhere after a password reset.
CREATE INDEX session_user_idx ON session ((sess ->> 'userId'));
