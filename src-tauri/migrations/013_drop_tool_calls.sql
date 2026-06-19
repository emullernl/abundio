-- Drop the unused tool_calls_count column from agent_turn.
--
-- The Tool-calls metric was removed from the Statistics UI earlier (it couldn't
-- be measured reliably — Abundio observes agents from the outside, so not every
-- agent surfaces a tool-call signal). This removes the now-dead column from the
-- schema; the frontend no longer reads or writes it.
--
-- No index or foreign key references tool_calls_count, so a plain DROP COLUMN
-- is safe (SQLite >= 3.35, bundled with rusqlite). Existing rows keep all their
-- other telemetry untouched.

ALTER TABLE agent_turn DROP COLUMN tool_calls_count;
