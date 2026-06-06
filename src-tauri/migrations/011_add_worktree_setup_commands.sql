-- Per-Workspace setup commands run in a newly created worktree's terminal
-- immediately after an in-app "Add worktree" (Worktree setup commands).
-- Stored on the main-worktree Workspace's row; empty string = none.
ALTER TABLE workspaces ADD COLUMN worktree_setup_commands TEXT NOT NULL DEFAULT '';
