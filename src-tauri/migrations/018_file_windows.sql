-- Markdown windows become File windows (ADR-0049): a window can now show a
-- text file, an image, a file's live diff, or one file in one commit. The
-- table gains a `kind`, and the key becomes (Workspace, kind, file, commit),
-- so a file's text window and its diff window are two rows, and one file at
-- two commits is two rows.
--
-- `commit_oid` is '' rather than NULL for every kind but 'commit-diff': a
-- NULL in a primary-key column would make every such row unique.
-- `diff_section` is the git section a live diff was last opened from. It is
-- not part of the key: like a diff pane, there is one live diff per file.
--
-- Labels are kept as they are (`md-<uuid>`), so every remembered window keeps
-- its saved size and position. Nothing references this table, so a plain
-- rebuild needs no foreign_keys pragma.

CREATE TABLE file_windows (
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    -- 'text' | 'image' | 'diff' | 'commit-diff'
    kind           TEXT NOT NULL DEFAULT 'text',
    -- Absolute for 'text' and 'image'; Workspace-relative for the two diffs.
    file_path      TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    commit_oid     TEXT NOT NULL DEFAULT '',
    diff_section   TEXT,
    label          TEXT NOT NULL UNIQUE,
    -- 'rendered' | 'source' (markdown text windows only)
    view           TEXT NOT NULL DEFAULT 'rendered',
    created_at     INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (workspace_id, kind, canonical_path, commit_oid)
);

INSERT OR IGNORE INTO file_windows
    (workspace_id, kind, file_path, canonical_path, label, view, created_at)
SELECT workspace_id, 'text', file_path, canonical_path, label, view, created_at
FROM markdown_windows;

DROP TABLE markdown_windows;
