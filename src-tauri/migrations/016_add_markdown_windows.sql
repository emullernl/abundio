-- Markdown windows: one row per remembered Markdown window, so it reopens when
-- its Workspace is next opened. See ADR-0046 and docs/plans/markdown-window.md.
--
-- A row exists while the window is open AND while it is remembered (closed by
-- its owner: Workspace close, Profile switch, owning Window close, quit). A
-- window the user closes themselves deletes its row.
--
-- `label` is generated once and kept, because tauri-plugin-window-state keys
-- the saved geometry by window label.

CREATE TABLE markdown_windows (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    file_path    TEXT NOT NULL,
    label        TEXT NOT NULL UNIQUE,
    -- 'rendered' | 'source'
    view         TEXT NOT NULL DEFAULT 'rendered',
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (workspace_id, file_path)
);
