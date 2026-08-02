---
status: accepted
---

# On-disk state is split into a shared root and a versioned data epoch

Migration 013 (ADR-0024) drops `workspaces.env_json`. An older Abundio binary
still names that column in its `workspace_list` SELECT, so once the migration
runs, **every previously installed version fails to list workspaces**. Installing
this build would mean burning the bridge behind you: no fallback to a known-good
version, and no way to run old and new side by side while a large change settles.

**Decision:** `<data>/abundio/` splits into a **shared root** and a
**versioned root** `<data>/abundio/<DATA_EPOCH>/`, currently `v2`. On first run
of a new epoch, the previous epoch's database is **copied** — not moved — so the
older build keeps working against its own data.

`DATA_EPOCH` is bumped only when a schema change makes older builds unable to
read the database. It is not the app version; many app versions share one epoch.

## What is versioned, and why each one

The database was the obvious conflict. The other three were not, and each would
have failed *silently*:

| Path | Why it must be per-epoch |
|---|---|
| `abundio.db` | 013 drops a column older builds still SELECT |
| `shell-integration/` | Rewritten unconditionally by whichever build spawns a terminal first. An older build's wrapper scripts have no `ABUNDIO_ENV_KEYS` re-export block, so it would quietly disable this version's environment injection — no error, variables just stop arriving |
| `pty-logs/` | Keyed by pane id. The new database *starts as a copy*, so both builds hold identical pane ids and would interleave writes into the same `<paneId>.log` |
| `windows.json` | The two builds overwrite each other's window restore state on quit |

## What stays shared, and why

`hooks/` and `shims/` — the agent hook relay scripts. These describe the machine,
not a build: the relay reads its port and token from the pane's environment at
fire time, so it is version-independent by construction. Duplicating them would
provision the user's *global* agent config (`~/.claude`, etc.) twice, which is
worse than sharing.

## The import is a SQLite backup, not a file copy

The source database is in WAL mode, so its `.db` file alone is missing everything
still in the `-wal`. Verified on real data: a plain `cp` of just the `.db`
produced 48 tabs where the database actually had 49.

`app_paths::copy_database` therefore uses the SQLite backup API, which produces a
consistent snapshot including uncheckpointed WAL frames, and opens the source
`SQLITE_OPEN_READ_ONLY` so a *running* older build cannot be disturbed. A failed
import deletes the partial target: an empty database is recoverable, a truncated
one is not.

`pty-logs` is copied alongside so scrollback survives the transition — the pane
ids carry over, so the logs would otherwise be orphaned. Best-effort: losing
scrollback is cosmetic, and must not fail the import.

## Consequences

- Two builds of different epochs can run simultaneously. Their workspaces,
  layouts and scrollback diverge from the moment of the copy — this is a fork,
  not a sync.
- **Disk usage roughly doubles** for the database and PTY logs. Both are small
  (megabytes), and the old epoch can be deleted once the new one is trusted.
- Two things remain shared and are *not* fixed here, because they are keyed by
  the app's bundle identifier rather than by our own paths:
  `tauri-plugin-window-state` geometry, and the webview's `localStorage` (which
  holds the settings store). Co-installed builds share window positions and
  appearance settings. Cosmetic, and separating them would mean shipping a
  distinct bundle identifier — a much larger change.
- Adding a new state file means deciding which side it belongs on. The default
  should be *versioned*: sharing is the exception, and the failure mode of
  getting it wrong is silent.
