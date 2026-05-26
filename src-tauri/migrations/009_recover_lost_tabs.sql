-- Recovery migration for users affected by the original 008_add_profiles bug.
--
-- The first published version of 008 disabled FK enforcement via
-- `PRAGMA foreign_keys = OFF` at the start of the migration SQL, but the
-- migration framework wraps the SQL in a SAVEPOINT and SQLite documents that
-- `PRAGMA foreign_keys` is a no-op inside a transaction. So FK enforcement
-- stayed ON, and `DROP TABLE workspaces` cascade-deleted every row in tabs
-- via the existing `tabs.workspace_id ON DELETE CASCADE` FK.
--
-- This migration finds every workspace currently sitting with zero tabs and
-- creates a default "Terminal 1" tab for it, mirroring what the WorkspaceStore
-- would have created on workspace creation. The lost pane layouts and
-- scrollback state are irrecoverable, but the user can at least use each
-- workspace again as if it were fresh.
--
-- Workspaces created AFTER 008 will already have tabs and so are unaffected.

INSERT INTO tabs (id, workspace_id, name, layout_json, position)
SELECT
    -- Tab id (UUIDv4 via random hex blocks).
    lower(
        hex(randomblob(4)) || '-' ||
        hex(randomblob(2)) || '-4' ||
        substr(hex(randomblob(2)), 2) || '-' ||
        substr('89ab', abs(random()) % 4 + 1, 1) ||
        substr(hex(randomblob(2)), 2) || '-' ||
        hex(randomblob(6))
    ),
    w.id,
    'Terminal 1',
    -- Pane id (separate UUID) inlined into the layout JSON so each recovered
    -- workspace gets a unique pane id rather than the literal "default" that
    -- would collide if a user has multiple recovered workspaces visible.
    '{"type":"terminal","id":"' || lower(
        hex(randomblob(4)) || '-' ||
        hex(randomblob(2)) || '-4' ||
        substr(hex(randomblob(2)), 2) || '-' ||
        substr('89ab', abs(random()) % 4 + 1, 1) ||
        substr(hex(randomblob(2)), 2) || '-' ||
        hex(randomblob(6))
    ) || '","ptyId":""}',
    0
FROM workspaces w
LEFT JOIN tabs t ON t.workspace_id = w.id
WHERE t.id IS NULL;
