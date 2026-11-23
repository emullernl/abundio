-- Workspace restore (ADR-0052): which Workspaces a Profile had Opened, and
-- which one was Active, so the Profile comes back as it was left. Written on
-- every change (not at quit), so a crash restores too.
ALTER TABLE workspaces ADD COLUMN restore_opened INTEGER NOT NULL DEFAULT 0;
-- No foreign key: ALTER TABLE cannot add one. A stale id is cleared on read
-- by `WorkspaceStore::restore_set`.
ALTER TABLE profiles ADD COLUMN restore_active_workspace_id TEXT DEFAULT NULL;
