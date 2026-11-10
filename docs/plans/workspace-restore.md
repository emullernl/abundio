# Workspace restore

When a Profile opens in a Window, reopen the Workspaces that were Opened when it was last open, and make the Active one Active again. See `GLOSSARY.md` (**Workspace restore**) and ADR-0052.

## Why

The Opened set lives only in memory (`usePtyActivityStore.openedWorkspaceIds`), and `loadWorkspaces` starts every Window with `activeWorkspaceId: null`. Windows and Profiles come back after a restart (`windows.json`), but the work inside them does not.

## Decisions (from the design session)

| Topic | Decision |
|-------|----------|
| What comes back | Every Opened workspace (however it got Opened, Fleet Console included), plus the Active one. |
| When | Whenever a Profile opens in a Window: app start, Switch Profile, new Window with Profile. |
| Owner of the list | The Profile. |
| Terminals | All restored Workspaces spawn their PTYs right away. Agent panes relaunch and resume (ADR-0050). |
| Saving | Every change, straight to SQLite. Crash-safe. Nothing is done at quit. |
| What removes a Workspace from the list | Only the user closing it, or deleting it (including worktree removal). Switch Profile and closing a Window keep it. |
| Missing folder | Left unopened but kept on the list, so it comes back once the folder does (an external drive, network share or encrypted volume mounted late). If it was the Active one, the first restored Workspace in sidebar order becomes Active. No dialog. Changed after the PR review: the first version forgot it for good. |
| View | Always the Workspace view, never the Fleet Console. |
| Setting | "Reopen workspaces when a Profile opens", on by default. Off: nothing is reopened in any case. The list keeps being saved while off, so turning it on again picks up the latest state. |
| Name | "Workspace restore". Not "session restore", which clashes with Session resume. |

## Steps (ordered commits on one branch, `workspace-restore`)

Before running the app with step 1 in place, back up `abundio.db` (+ `-wal`, `-shm`): there are no down-migrations.

### 1. Storage (Rust)

- Migration `020_workspace_restore.sql`:
  - `ALTER TABLE workspaces ADD COLUMN restore_opened INTEGER NOT NULL DEFAULT 0;`
  - `ALTER TABLE profiles ADD COLUMN restore_active_workspace_id TEXT DEFAULT NULL;` (no FK: `ALTER TABLE` cannot add one cleanly; a stale id is ignored on read and cleared, see below).
- `workspace_store.rs`:
  - `set_restore_opened(workspace_id, bool)`.
  - `set_restore_active(profile_id, Option<workspace_id>)`.
  - `restore_set(profile_id) -> RestoreSet { opened: Vec<String>, active: Option<String> }`. Returns only Workspaces of that Profile whose `root_folder` is an existing directory. Missing folders are left out but keep `restore_opened`; the folders are checked with the lock released. It clears `restore_active_workspace_id` if it no longer names a returned Workspace. Order: sidebar `position`.
- Commands in `commands.rs`: `workspace_restore_set`, `workspace_set_restore_opened`, `workspace_set_restore_active`. All `Result<_, AbundioError>`.
- Tests (in-memory DB): round-trip; missing folder is dropped and cleared; a Workspace of another Profile is never returned; stale active id is cleared; deleting a Workspace or Profile leaves nothing behind.

### 2. Frontend wiring

- `lib/ipc.ts`: typed wrappers for the three commands. `lib/demo/`: in-memory mocks so `pnpm demo:web` keeps working.
- `lib/workspaceRestore.ts` (new, pure where possible):
  - `rememberOpened(id)` / `forgetOpened(id)` / `rememberActive(profileId, id)` — fire-and-forget IPC, errors logged, never thrown.
  - `pickActive(restoreSet)`: the saved Active if present, else the first opened, else `null`.
- Remember on Open: `ptyActivityStore.markWorkspaceOpened` is the single place every path goes through (sidebar click, Workspace cycle, Fleet Console, New task, new Workspace). It calls `rememberOpened` when the id is new to the set. `ptyActivityStore` must not import `workspaceStore`; `workspaceRestore.ts` imports only `ipc`.
- Remember Active: `setActiveWorkspace` calls `rememberActive(activeProfileId, id)` when `id` is not null. A `null` (closing the Active workspace) is not saved; the restore falls back via `pickActive`.
- Forget: `closeWorkspace(id, { forget = true })`. Forgetting calls `forgetOpened(id)`. `profileStore.switchProfile` passes `{ forget: false }`. `deleteWorkspace` and `removeWorktreeWorkspace` need nothing: the row is gone.
- Window close: no change. It does not go through `closeWorkspace`, so the list stays. Quit: no change.

### 3. Restore

- At the end of `loadWorkspaces` (it runs at Window start and after every Switch Profile), when the setting is on:
  1. `workspace_restore_set(profileId)`.
  2. `markWorkspaceOpened` for each returned id (this spawns PTYs as `TerminalPool` mounts them, and starts their File window restore).
  3. `setActiveWorkspace(pickActive(set))`.
- Must not race the existing "keep the Active id if it is still in the list" logic in `loadWorkspaces`: restore wins only when the current Active is `null`.
- Session resume: `loadWorkspaces` already seeds pending agents for every pane with the per-folder counts, so restored Agent panes resume with no extra work. Verify in the real app that two restored Workspaces on the same folder do not both take the folder's latest session.
- Demo mode: `useDemoBootstrap` sets its own Active workspace; skip restore when `VITE_ABUNDIO_DEMO` is set.

### 4. Setting

- `settingsStore`: `reopenWorkspacesOnOpen: boolean`, default `true`. Synced to other windows like the rest of the slice.
- Settings panel: a `ToggleRow` labelled "Reopen workspaces when a Profile opens", with a one-line hint that it starts every reopened Workspace's terminals and agents.

### 5. Docs

- `CLAUDE.md`: under Key Conventions, one bullet: Profile switch must call `closeWorkspace(id, { forget: false })`, or the Profile's Workspace restore list is emptied (ADR-0052). Add `lib/workspaceRestore.ts` to the Lib list.

## Tests

- Rust: as in step 1.
- Vitest:
  - `workspaceRestore.pickActive` cases.
  - `markWorkspaceOpened` remembers only on first add.
  - `closeWorkspace` forgets by default and keeps with `{ forget: false }`; `switchProfile` keeps.
  - `loadWorkspaces` restores Opened + Active when on; restores nothing when off; does not override a non-null Active.
- Runtime (real app, per the "verify runtime" rule): open three Workspaces with an agent in one, quit with Cmd+Q, relaunch → all three Opened, same Active, agent resumed. Repeat with `kill -9` instead of quit. Switch Profile away and back. Rename a Workspace's folder, relaunch → it is unopened; rename it back, relaunch → it is reopened.
