-- Secrets vault: metadata only. Secret VALUES are never stored here — they
-- live in the OS keychain, keyed by the secret id (see secrets_store.rs).
CREATE TABLE IF NOT EXISTS secrets (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,            -- env var name, e.g. OPENAI_API_KEY
    description TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Per-workspace assignment: which vault secrets are injected into a
-- workspace's terminals at PTY spawn. Both sides cascade so deleting a
-- secret or a workspace clears the assignment automatically.
CREATE TABLE IF NOT EXISTS workspace_secrets (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    secret_id    TEXT NOT NULL REFERENCES secrets(id)    ON DELETE CASCADE,
    PRIMARY KEY (workspace_id, secret_id)
);
