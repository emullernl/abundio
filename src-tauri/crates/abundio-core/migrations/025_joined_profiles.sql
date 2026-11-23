-- Joined profiles (docs/plans/remote-hosts.md phase 10, GLOSSARY.md): the
-- Remote profiles a local Profile shows in its Window, each in a section of
-- its own. `workspaces_json` is the last Workspace list the Host gave, shown
-- greyed while it cannot be reached; `last_seen_ms` is when that was.
-- One per Host: a Window is one Client there, showing one Profile.
CREATE TABLE IF NOT EXISTS joined_profiles (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    host_id TEXT NOT NULL,
    remote_profile_id TEXT NOT NULL,
    remote_profile_name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    workspaces_json TEXT NOT NULL DEFAULT '[]',
    last_seen_ms INTEGER,
    PRIMARY KEY (profile_id, host_id)
);
