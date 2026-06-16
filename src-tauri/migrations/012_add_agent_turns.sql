-- Agent Turn telemetry. One row per Turn (a single prompt -> turn-finished
-- cycle). See docs/plans/agent-turn-telemetry-and-statistics-overlay.md and
-- ADR-0018.
--
-- Lifetime (deliberate split, ADR-0018):
--   * profile_id is a NOT NULL FK with ON DELETE CASCADE: deleting a Profile
--     wipes its Turns (matches workspaces.profile_id; the rows are unviewable
--     under Profile-scoped viewing anyway).
--   * workspace_id is a PLAIN column (NOT a FK): deleting a Workspace must NOT
--     shrink historical totals, so its Turns survive. workspace_path /
--     workspace_name are denormalized so a deleted Workspace stays labelable.
--
-- Timestamps: started_at/ended_at/duration_ms/working_ms/waiting_ms are Unix
-- MILLISECONDS (the turn lifecycle is driven by the frontend's Date.now()).
-- created_at is Unix SECONDS (row provenance; matches the notes/tabs convention).
--
-- Line counts (lines_added/lines_deleted/files_changed) are NULLABLE: NULL means
-- "unattributed" -- e.g. two Turns ran concurrently in the same Workspace and the
-- per-Workspace git delta can't be split between them. The raw git_*_start/end
-- snapshots are kept even when the headline counts are NULL, for debugging and
-- future re-derivation.

CREATE TABLE agent_turn (
    id                        TEXT PRIMARY KEY,         -- uuid, minted frontend at turn start
    session_id                TEXT,                     -- groups turns of one agent process in a pty
    profile_id                TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    workspace_id              TEXT,                     -- nullable, NOT a FK (survives workspace delete)
    workspace_path            TEXT NOT NULL DEFAULT '',
    workspace_name            TEXT NOT NULL DEFAULT '',
    agent_id                  TEXT NOT NULL,            -- claude | copilot | gemini | ...
    pty_id                    TEXT NOT NULL DEFAULT '',
    started_at                INTEGER NOT NULL,         -- ms
    ended_at                  INTEGER,                  -- ms; NULL while open
    duration_ms               INTEGER,                  -- wall clock = ended_at - started_at
    working_ms                INTEGER,                  -- time in Working state
    waiting_ms                INTEGER,                  -- time in Waiting state (blocked on user)
    end_reason                TEXT,                     -- stop|error|session_end|pty_exit|app_quit|orphan_recovered
    permission_requests_count INTEGER NOT NULL DEFAULT 0,
    tool_calls_count          INTEGER NOT NULL DEFAULT 0,
    error_count               INTEGER NOT NULL DEFAULT 0,
    lines_added               INTEGER,                  -- NULL = unattributed (overlap / unknown)
    lines_deleted             INTEGER,
    files_changed             INTEGER,
    git_added_start           INTEGER,                  -- raw snapshots (debug / re-derivation)
    git_deleted_start         INTEGER,
    git_added_end             INTEGER,
    git_deleted_end           INTEGER,
    created_at                INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Primary dashboard query: WHERE profile_id=? AND started_at IN [from,to)
CREATE INDEX idx_agent_turn_profile_started   ON agent_turn (profile_id, started_at);
CREATE INDEX idx_agent_turn_agent_started     ON agent_turn (agent_id, started_at);
CREATE INDEX idx_agent_turn_workspace_started ON agent_turn (workspace_id, started_at);
CREATE INDEX idx_agent_turn_session           ON agent_turn (session_id);
CREATE INDEX idx_agent_turn_open              ON agent_turn (ended_at) WHERE ended_at IS NULL;
