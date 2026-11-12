-- Pane numbers for Agent control (ADR-0054): a short, Workspace-wide id for a
-- Pane (`p1`, `p2`…), never reused after its Pane closes, kept across restarts.
--
-- Kept here, keyed by the Pane's own id, rather than in the layout JSON: the
-- frontend writes layouts from many places, and any write that forgot the
-- field would silently drop the number. Pane ids already survive restarts.
--
-- Rows of closed Panes are kept; the counter alone guarantees no reuse, and a
-- stale row costs nothing.
ALTER TABLE workspaces ADD COLUMN next_pane_number INTEGER NOT NULL DEFAULT 1;

CREATE TABLE pane_numbers (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    pane_id      TEXT NOT NULL,
    number       INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, pane_id),
    UNIQUE (workspace_id, number)
);
