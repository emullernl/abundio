-- Profiles are a top-level grouping over Workspaces. See ADR-0006.
-- Each Workspace belongs to exactly one Profile via profile_id (NOT NULL FK,
-- ON DELETE CASCADE).
--
-- SQLite forbids `ALTER TABLE ... ADD COLUMN` when the column has both a
-- REFERENCES clause and a non-NULL DEFAULT. So we use the standard SQLite
-- table-rebuild dance instead: disable FK enforcement, build a new table
-- with the desired schema, copy data into it (backfilling profile_id to the
-- well-known default-profile UUID), drop the old table, rename.
--
-- All `CREATE TABLE` / `INSERT` statements are written idempotently so the
-- migration can recover from a previous-attempt partial state — e.g. an
-- earlier broken version of this migration that managed to create the
-- profiles table before erroring on the workspaces ALTER.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO profiles (id, name, position) VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Default',
    0
);

-- Clean up any leftover rebuild artifact from a previous failed attempt.
DROP TABLE IF EXISTS workspaces_new;

CREATE TABLE workspaces_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_folder TEXT NOT NULL,
    env_json TEXT NOT NULL DEFAULT '{}',
    agent_presets_json TEXT NOT NULL DEFAULT '[]',
    file_tabs_json TEXT NOT NULL DEFAULT '{}',
    base_branch TEXT,
    last_branch TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    profile_id TEXT NOT NULL
        DEFAULT '00000000-0000-0000-0000-000000000001'
        REFERENCES profiles(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO workspaces_new
    (id, name, root_folder, env_json, agent_presets_json, file_tabs_json,
     base_branch, last_branch, position, profile_id, created_at, updated_at)
SELECT id, name, root_folder, env_json, agent_presets_json, file_tabs_json,
       base_branch, last_branch, position,
       '00000000-0000-0000-0000-000000000001',
       created_at, updated_at
FROM workspaces;

DROP TABLE workspaces;
ALTER TABLE workspaces_new RENAME TO workspaces;

CREATE INDEX IF NOT EXISTS idx_workspaces_profile_id ON workspaces(profile_id);

PRAGMA foreign_keys = ON;
