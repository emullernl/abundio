-- "No Environment Bundle is injected" as an explicit per-Workspace state.
--
-- The absence of an `injected` flag is not enough for a linked worktree: it
-- inherits its main worktree's Bundles, so opting out has to survive the parent
-- later injecting a *different* Bundle. This flag is checked before inheritance
-- and is cleared whenever a Bundle is explicitly injected. See ADR-0024.
ALTER TABLE workspaces ADD COLUMN env_injection_disabled INTEGER NOT NULL DEFAULT 0;
