-- Per-Workspace encrypted environment variables, grouped into named Bundles.
--
-- Exactly one Bundle per Workspace is INJECTED into every PTY's environment at
-- spawn; the rest are on-demand and readable only through the `abundio-env`
-- helper. The partial unique index makes "exactly one injected" an enforced
-- property rather than a naming convention.
CREATE TABLE workspace_env_bundles (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    injected     INTEGER NOT NULL DEFAULT 0,
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (workspace_id, name)
);

CREATE INDEX idx_env_bundles_workspace ON workspace_env_bundles(workspace_id);

CREATE UNIQUE INDEX idx_env_bundles_one_injected
    ON workspace_env_bundles(workspace_id) WHERE injected = 1;

-- Variable names are PLAINTEXT: they are needed to build the shell environment
-- and to render the settings list without ever touching the keychain. Only
-- VALUES are encrypted -- AES-256-GCM under a single 32-byte master key held in
-- the OS keychain (service "abundio", entry "env-master-key").
--
-- `nonce` is a per-row random 96-bit GCM nonce. `ciphertext` INCLUDES the
-- trailing 16-byte GCM tag, so plaintext length == length(ciphertext) - 16.
-- That identity is what lets the list IPC report a byte size without
-- decrypting anything.
CREATE TABLE workspace_env_vars (
    id         TEXT PRIMARY KEY,
    bundle_id  TEXT NOT NULL REFERENCES workspace_env_bundles(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    nonce      BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (bundle_id, name)
);

CREATE INDEX idx_env_vars_bundle ON workspace_env_vars(bundle_id);

-- Drop the dead `workspaces.env_json` column. Written as '{}' since 001_init,
-- never read by anything. Keeping it alongside the tables above would leave two
-- things in the schema called "environment variables".
--
-- Safe to DROP without a table rebuild: it is not a PK member, not UNIQUE, not
-- indexed, and not referenced by any FK, CHECK, trigger, view or generated
-- column. SQLite supports ALTER TABLE DROP COLUMN since 3.35; rusqlite 0.31
-- bundles 3.45.
ALTER TABLE workspaces DROP COLUMN env_json;
