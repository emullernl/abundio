-- Per-workspace Note: a single rich-text scratchpad (free text + checklists)
-- stored as opaque TipTap/ProseMirror JSON. workspace_id is the PRIMARY KEY,
-- enforcing exactly one note per workspace and making upsert trivial. The note
-- is removed automatically when its workspace is deleted.
CREATE TABLE notes (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
