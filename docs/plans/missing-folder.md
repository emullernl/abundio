# Missing folder

Show when a Workspace's folder is missing, and never start a terminal there. See `GLOSSARY.md` (**Missing folder**) and ADR-0053.

## Why

`pty_manager.rs` only calls `cmd.cwd(cwd)` when `cwd` is a directory, so a pane whose folder is missing starts in the home folder, and an Agent pane relaunches its agent there without a word. Workspace restore (ADR-0052) keeps such Workspaces on the restore list, so this becomes more likely.

## Decisions (from the design session)

| Topic | Decision |
|-------|----------|
| Name | "Missing folder" in the glossary; "Folder not found" in the UI. |
| When to check | When the Workspace list loads, and when the Window gets focus. No background polling. |
| Sidebar | Amber `FolderX` mark after the name; hover shows `Folder not found: <path>`. Collapsed sidebar: small amber dot on the icon. |
| Selecting it | Active but not Opened. The main area shows a "Folder not found" panel with the path, **Try again** and **Remove workspace**. Nothing starts. |
| Remove workspace | Deletes the Workspace from Abundio only (usual confirm). Never runs git. |
| Restore list | A Workspace only seen in the panel is not added (it was never Opened). |
| Folder disappears while Opened | Running terminals keep going; the row gets the mark. New terminals, pane restarts and agent relaunches are refused, and the pane prints `Folder not found: <path>`. |
| Pane's own folder missing, Workspace folder exists | Start in the Workspace folder. Never the home folder. |
| Folder comes back | On the restore list → reopens in the background (not Active). Shown in the panel → opens in place. |
| Fleet Console picker, New task, New agent | Listed with the mark, not selectable. |
| Locate folder… | Not in this change. |

## Steps (ordered commits on `feat/missing-folder`)

### 1. Rust: never start in the wrong folder

- `error.rs`: new variant `FolderMissing(String)`, displayed as `Folder not found: {0}`.
- `pty_spawn` (`commands.rs`): when `workspace_id` is set, read that Workspace's `root_folder` from `WorkspaceStore`, then release the lock before checking the disk.
  - Folder is not a directory → return `FolderMissing(root_folder)`; nothing is spawned.
  - Folder exists but `cwd` does not → spawn with `cwd = root_folder`.
  - Unknown Workspace id, or no id → unchanged (today's behaviour).
- Pure helper `resolve_spawn_cwd(cwd, root, is_dir) -> Result<String, AbundioError>`, unit tested.
- New command `workspace_missing_folders(profile_id) -> Vec<String>`: ids of that Profile's Workspaces whose folder is not a directory. Folders are checked with the lock released.

### 2. Frontend state

- `ipc.ts`: `workspaces.missingFolders(profileId)`. Demo mock returns `[]`.
- `workspaceStore`: `missingFolderIds: Set<string>` and `refreshMissingFolders()`:
  1. Fetch the ids and set them.
  2. For ids that were missing and are now present: if the id is Active and not Opened → `markWorkspaceOpened` (opens in place). Then `restoreSet(profile)`; each returned id that came back and is not Opened → `markWorkspaceOpened` (background, not Active).
- Call it at the end of `loadWorkspaces`, **before** the restore. Call it again on Window focus (`addWindowFocusListener`, from a hook mounted in `App.tsx`).
- `setActiveWorkspace` / `beginWorkspaceSwitch`: for a Missing-folder Workspace, set it Active without marking it Opened (no slow-path overlay either).
- `ptyActivityStore.markWorkspaceOpened`: refuse to newly mark a Missing-folder Workspace. It is the one place every opening path passes through, so pickers cannot bypass the rule.

### 3. Spawn refusal in the pane

- `terminalManager.spawnNewPty`: on `Folder not found`, print it in amber in the terminal, and leave the pane without a PTY (no fallback spawn, unlike a refused New task). Find out during this step how a pane with no PTY behaves (status icon, restart, close) and keep it inert and closable.

### 4. UI

- `WorkspaceItem`: the mark and the hover text. `CollapsedStrip`: the dot.
- `components/MissingFolderPanel.tsx`: rendered by `App.tsx` when the Active workspace is in `missingFolderIds` and not Opened. **Try again** calls `refreshMissingFolders`. **Remove workspace** goes through the existing delete confirm.
- `WorkspacePicker` (Fleet Console), `NewTaskDialog`, `NewAgentDialog`: Missing-folder rows are disabled, with the mark and a "Folder not found" hint.

### 5. Docs

- `CLAUDE.md`: a Key Conventions bullet. `pty_spawn` refuses a Missing folder and never falls back to the home folder for a Workspace pane, and `activeWorkspaceId` may name a Workspace that is not Opened (ADR-0053).

## Tests

- Rust: `resolve_spawn_cwd` (folder missing → error; cwd missing → root; both present → cwd); `workspace_missing_folders` scoped to its Profile.
- Vitest: `refreshMissingFolders` (comes back while Active → opened in place; comes back on the restore list → opened in background; not on the list → not opened); `setActiveWorkspace` on a Missing folder does not mark Opened; `markWorkspaceOpened` refuses it; the restore skips it; pickers disable it; the panel shows for Active + Missing + not Opened.
- Runtime (real app): point a Workspace at a folder on a USB stick or disk image, open it with an agent, and quit. Eject, relaunch: the row is marked, clicking it shows the panel, and no shell runs in `~`. Mount it and focus the Window: it reopens and the agent resumes. Also eject while the Workspace is open: terminals keep running, and a split prints `Folder not found`.
