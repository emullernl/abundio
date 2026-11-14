-- Orchestrator (ADR-0057, docs/plans/orchestrator.md step 1).
-- kind: 'work' for every ordinary Workspace, 'orchestrator' for a Profile's
-- Orchestrator workspace. At most one Orchestrator workspace per Profile.
ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';
CREATE UNIQUE INDEX idx_one_orchestrator_per_profile ON workspaces(profile_id) WHERE kind = 'orchestrator';

-- The Agent the user picked to be this Profile's Orchestrator (an agent id), or NULL until picked.
ALTER TABLE profiles ADD COLUMN orchestrator_agent_id TEXT DEFAULT NULL;

-- Orchestrator tabs that hold a file (ADR-0058). The graph tab is implicit and
-- the Peek tab is never remembered. kind: 'file' | 'diff' | 'commit'.
-- path is absolute for 'file', Workspace-relative for 'diff' and 'commit'.
CREATE TABLE orchestrator_tabs (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'diff', 'commit')),
    path TEXT NOT NULL,
    commit_oid TEXT,
    preview INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_orchestrator_tabs_profile ON orchestrator_tabs(profile_id, position);
ALTER TABLE profiles ADD COLUMN orchestrator_selected_tab TEXT DEFAULT NULL;
