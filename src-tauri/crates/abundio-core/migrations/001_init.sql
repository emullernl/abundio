CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_folder TEXT NOT NULL,
    layout_json TEXT NOT NULL DEFAULT '{"type":"terminal","id":"default","ptyId":""}',
    env_json TEXT NOT NULL DEFAULT '{}',
    agent_presets_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
