-- Step 1: Save layout data before dropping the column
CREATE TABLE _tab_migration (
    session_id TEXT NOT NULL,
    layout_json TEXT NOT NULL
);

INSERT INTO _tab_migration (session_id, layout_json)
SELECT id, layout_json FROM sessions;

-- Step 2: Recreate sessions table without layout_json
ALTER TABLE sessions RENAME TO _sessions_old;

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_folder TEXT NOT NULL,
    env_json TEXT NOT NULL DEFAULT '{}',
    agent_presets_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO sessions (id, name, root_folder, env_json, agent_presets_json, created_at, updated_at)
SELECT id, name, root_folder, env_json, agent_presets_json, created_at, updated_at FROM _sessions_old;

DROP TABLE _sessions_old;

-- Step 3: Create tabs table (FK references the NEW sessions table)
CREATE TABLE tabs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    layout_json TEXT NOT NULL DEFAULT '{"type":"terminal","id":"default","ptyId":""}',
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_tabs_session_id ON tabs(session_id);

-- Step 4: Migrate saved layouts into tabs
INSERT INTO tabs (id, session_id, name, layout_json, position)
SELECT
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
    session_id,
    'Terminal 1',
    layout_json,
    0
FROM _tab_migration;

DROP TABLE _tab_migration;
