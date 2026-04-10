ALTER TABLE sessions RENAME TO workspaces;
ALTER TABLE tabs RENAME COLUMN session_id TO workspace_id;
DROP INDEX IF EXISTS idx_tabs_session_id;
CREATE INDEX idx_tabs_workspace_id ON tabs(workspace_id);
