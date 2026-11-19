ALTER TABLE sessions ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

UPDATE sessions SET position = (
  SELECT COUNT(*) FROM sessions s2 WHERE s2.created_at < sessions.created_at
);
