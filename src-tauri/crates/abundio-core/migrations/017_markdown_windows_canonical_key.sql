-- One Markdown window per *file*, not per spelling of its path. 016 keyed the
-- row by `file_path` exactly as the frontend wrote it, so a backslash and a
-- forward-slash spelling (Windows), a symlinked folder, or a different case on
-- a case-insensitive disk gave one file two rows and two windows, each with
-- its own buffer. The key is now the canonical path; `file_path` keeps the
-- spelling the window shows and matches watcher events against.
--
-- Rows from 016 start with canonical_path = file_path; restore recomputes it
-- and drops a row that turns out to duplicate another (see
-- `md_windows_restore`). Nothing references this table, so a plain rebuild
-- needs no foreign_keys pragma.

CREATE TABLE markdown_windows_new (
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    file_path      TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    label          TEXT NOT NULL UNIQUE,
    -- 'rendered' | 'source'
    view           TEXT NOT NULL DEFAULT 'rendered',
    created_at     INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (workspace_id, canonical_path)
);

INSERT OR IGNORE INTO markdown_windows_new
    (workspace_id, file_path, canonical_path, label, view, created_at)
SELECT workspace_id, file_path, file_path, label, view, created_at
FROM markdown_windows;

DROP TABLE markdown_windows;
ALTER TABLE markdown_windows_new RENAME TO markdown_windows;
