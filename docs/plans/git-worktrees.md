# Git worktree support for Abundio

## Context

Abundio binds each **Workspace** to a folder. Git supports multiple **worktrees** per repository — separate folders, each with a different branch checked out, all sharing one repository. Today Abundio has no awareness of this: two worktrees of the same repo are just two unrelated Workspaces.

This feature makes worktrees first-class. A repository with two or more worktrees renders its Workspaces as a **Worktree set** — a visually-distinct, primary-first cluster in the **Left sidebar**. Pointing the New Workspace dialog at any multi-worktree repo adds *all* its worktrees. Users can **Add worktree** (new or existing branch) from the primary, **Remove worktree** (delete files) from a linked one, and the sidebar **live-syncs** with `git worktree` commands run in any terminal. A main-worktree Workspace can also carry **Worktree setup commands** that run in a newly created worktree.

Domain terms (now in `CONTEXT.md`): **Worktree set**, **Primary worktree**, **Linked worktree**, **Workspace settings**, **Worktree setup commands**. Architecture rationale: **ADR-0017** (worktree sets are git-derived and live-reconciled).

`git2 = "0.19"` (vendored libgit2) is already a dependency and covers list / add / prune. This is mostly additive; the one schema change is a single column for setup commands.

## Decisions (resolved via grilling)

1. **Grouping is derived live from git, never stored.** Two Workspaces share a set iff their folders are worktrees of one repository. No `worktree_group_id` column. Mirrors how `currentBranch` is already fetched live with `lastBranch` as a cosmetic cache. (ADR-0017)
2. **`position` stays the ordering key**; render imposes set-contiguity + primary-first. A set is **atomic under drag** (grab any member → whole block moves; no tear-out, no within-set manual reorder in v1).
3. **Expansion**: picking a folder in a **≥2-worktree** repo snaps to the **worktree root** and adds *all* worktrees (dedup by canonical path, into the current Profile). Single-worktree repos behave exactly as today.
4. **Only the focal Workspace** activates + launches; siblings are **basename-named, unopened**, silent.
5. **Visual IA**: no header row; linked worktrees **indented under the primary on a rail**; no collapse in v1. Pixel styling via `/frontend-design` at build.
6. **Add worktree** — Primary-only, *also* offered on a standalone main-worktree (bootstraps a set). Branch name resolves **existing-or-new** (new forks from the primary's current HEAD). Default folder `../<repo>.worktrees/<branch, slashes→dashes>` relative to the primary root, live absolute preview, inline validation. **Includes the agent picker.**
7. **Remove worktree** — Linked-only, danger-styled. **Dirty-aware single confirm**, force-removes, **branch kept**, PTYs killed first, focus falls back to the primary, set auto-collapses.
8. **Context menu**: linked worktrees keep **both** `Close Workspace` (entry only) and `Remove worktree…` (files), distinguished by label + danger styling. `Add worktree…` on main-worktrees; `Workspace settings…` on all.
9. **Live CLI-sync**: bidirectional, **eager add** (incl. standalone bootstrap), one debounced watcher **per repo** per active Profile.
10. **Auto-remove is git-confirmed only** (worktree gone from the repo's worktree list). Ambiguous "folder missing but still listed" → **stale render**, never cascade-delete.
11. **Worktree setup commands** — stored on the main-worktree Workspace's row (per-Profile copy); edited in **Workspace settings**; run **only on in-app Add worktree**, visibly in the new worktree's focal terminal, as literal shell lines, **before** any chosen agent. No template vars in v1.

## Git derivation (keystone)

libgit2 facts the whole design rests on — get these wrong and grouping silently breaks:

- **`Repository::worktrees()` lists only *linked* worktrees**, never the main one. "All worktrees" = main repo + `worktrees()`.
- **git2 0.19 does NOT bind `commondir()`.** Verified — only `path()`, `workdir()`, `is_bare()`, `is_worktree()` exist on `Repository`. So the **group key is derived from `path()`**:
  ```
  common_git_dir = if repo.is_worktree() { repo.path().parent()?.parent()? }  // strip /worktrees/<name>
                   else                  { repo.path() }                       // main worktree's .git
  group_key = canonicalize(common_git_dir)
  ```
  Both the main worktree (`path()` = `<main>/.git`) and a linked worktree (`path()` = `<main>/.git/worktrees/<name>`) resolve to the same `<main>/.git`. This is git's own on-disk layout; note the assumption in code.
- **Primary detection**: `is_main_worktree = !repo.is_worktree() && !repo.is_bare() && repo.workdir().is_some()`. A bare repo has no primary → set renders flat (Q11 degradation).
- **`git_worktree_add` needs an *existing* ref** — `WorktreeAddOptions::reference()` won't create a branch. New branch = create branch first (`repo.branch(name, &primary_head_commit, false)`), then add the worktree pointing at it.
- **`Worktree::prune`** with `WorktreePruneOptions::valid(true).working_tree(true)` deletes the folder. Leave `locked(false)` so a locked worktree errors out (honored, not force-pruned).

## Implementation

### 1. Rust — git worktree layer (`src-tauri/src/git_libgit2.rs`)

Add pure-libgit2 helpers next to the existing ones (`current_branch_only`, `is_git_repo`, etc.):

- `worktree_group_key(cwd) -> Option<String>` — discover repo, compute `common_git_dir` per the keystone, canonicalize.
- `is_main_worktree(cwd) -> bool` — per the keystone.
- `list_repo_worktrees(cwd) -> Result<Vec<WorktreeEntry>, AbundioError>` — discover repo from `cwd`; open the main repo via `Repository::open(common_git_dir)` (its `workdir()` is the main worktree root, `None` if bare). Build:
  - main entry from `main.workdir()` (if `Some`) → `is_primary: true`;
  - linked entries: for each name in `main.worktrees()`, `main.find_worktree(name)?.path()`, skipping ones whose path is missing / `validate()` fails (stale/prunable);
  - per entry, `branch` = head shorthand of a repo opened at that path; `path` canonicalized.
  `WorktreeEntry { path: String, branch: Option<String>, is_primary: bool }`.
- `add_worktree(primary_cwd, branch, path) -> Result<(), AbundioError>`:
  1. Open main repo from `primary_cwd`.
  2. Resolve the branch ref: existing local branch → use it (error if already checked out in another worktree); `origin/<branch>` only → create a local tracking branch; neither → `repo.branch(branch, &repo.head()?.peel_to_commit()?, false)`.
  3. `WorktreeAddOptions::new().reference(Some(&branch_ref))`; `main.worktree(&worktree_name, Path::new(&path), Some(&opts))`. `worktree_name` = sanitized folder basename (git requires a unique admin name).
  4. On step-3 failure after step-2 created a branch, delete the orphaned branch (see Risks).
- `remove_worktree(primary_cwd, worktree_path) -> Result<(), AbundioError>` — open main repo, find the `Worktree` whose `path()` canonicalizes to `worktree_path`, `prune(valid(true).working_tree(true))`. Branch untouched.
- `worktree_is_dirty(cwd) -> bool` — reuse `StatusOptions` (as in `compute_status_fingerprint_sync`) to report any uncommitted/untracked entry, for the dirty-aware confirm.

New `AbundioError` variants as needed (or reuse `Git(String)`): e.g. branch-already-checked-out, target-exists, locked-worktree.

### 2. Rust — worktree commands (`src-tauri/src/worktree_commands.rs`, new)

Mirror `git_commands.rs` style (`#[tauri::command] async` wrapping `spawn_blocking`, `Result<T, AbundioError>`):

- `list_repo_worktrees(cwd) -> Vec<WorktreeEntry>` — for create-time expansion and the Add/Remove flows.
- `worktree_add(primary_cwd, branch, path) -> WorktreeEntry` — returns the created entry (so the frontend can add+activate it).
- `worktree_remove(primary_cwd, worktree_path)` — prune.
- `worktree_dirty(cwd) -> bool` — for the confirm dialog.

Register all in the `invoke_handler!` list (`lib.rs`/`commands.rs`).

### 3. Rust — extend per-workspace git summary (`src-tauri/src/git_commands.rs`)

`WorkspaceGitSummary` (L235) and `compute_workspace_git_summary` (L250) already open each workspace's repo for the branch chip. Add two fields, computed in the same pass (no extra repo open):
```rust
pub worktree_group_key: Option<String>,   // None when not a git repo
pub is_main_worktree: bool,
```
This is what the frontend groups on. Mirror in `WorkspaceGitInfo` (`workspaceGitStore.ts`).

### 4. Rust — setup-commands column (`src-tauri/migrations/011_add_worktree_setup_commands.sql`, new)

```sql
ALTER TABLE workspaces ADD COLUMN worktree_setup_commands TEXT NOT NULL DEFAULT '';
```
Auto-applied by `migrations.rs`. Then thread through `workspace_store.rs`: add `worktree_setup_commands` to the `Workspace` struct (L9), the `SELECT` lists (`list` L118, `get_workspace_with_conn` L343), `WorkspaceUpdate` (L24) + the `update` setter chain (L175), and the matching `Workspace`/`WorkspaceUpdate` interfaces in `src/lib/types.ts` (L53/L68). No change to `create` (defaults to '').

### 5. Rust — live-sync reconciler (`src-tauri/src/worktree_watcher.rs`, new; wired in `lib.rs` setup)

- On workspace-set changes (load / profile switch / after in-app add/remove), compute the set of **distinct `group_key`s** among the active Profile's git workspaces and (re)register one `notify` watcher per repo on its `<common_git_dir>/worktrees/` directory plus the worktree roots. Reuse the `notify` infrastructure from `file_watcher.rs`; **debounce** (~300–500ms) — fs events are bursty.
- On a debounced event, emit a Tauri event `worktrees-changed { group_key }` to the owning Window (per-Window/Profile scope — see the multi-window gotcha in `CLAUDE.md`; this listener must be registered in `App.tsx`). The frontend reconciles (§11).
- Keep this per-Window: each Window watches its own active Profile's repos.

### 6. Capabilities (`src-tauri/capabilities/default.json`)

The new `worktrees-changed` event + worktree commands ride existing `core:default` / event permissions for `main` / `window-*`. Confirm no new permission string is required for the emit/listen; if a dedicated event capability is added, list it for all Profile-window labels (multi-window gotcha).

### 7. Frontend IPC + types (`src/lib/ipc.ts`, `src/lib/types.ts`)

- New `worktrees` namespace following the existing `invoke`/`listen` pattern (route through the demo chokepoint at L37–47):
  - `listRepoWorktrees(cwd)`, `add(primaryCwd, branch, path)`, `remove(primaryCwd, worktreePath)`, `dirty(cwd)`.
  - `onWorktreesChanged(cb)` → `listen("worktrees-changed")`.
- `WorktreeEntry` type; extend `WorkspaceGitInfo` with `worktreeGroupKey`, `isMainWorktree`.

### 8. Frontend — derived grouping (`src/lib/worktreeGrouping.ts`, new + tests)

Pure, testable (extract per the testing convention). Input: ordered `WorkspaceWithTabs[]` + the `worktreeGroupKey`/`isMainWorktree` map from `workspaceGitStore`. Output: a render model — a flat list of rows where each row is either a standalone workspace or a **set block** (primary first, linked sorted by `position`), blocks ordered by their primary's `position`. Rules:
- Group only when **≥2** members share a `group_key` **and** one member is a main worktree present in the list; otherwise members render standalone (covers primary-less sets + bare repos — Q11).
- Set block sorts among rows by its primary's `position`.
This module is the single home for the "contiguity + primary-first" constraints from Decision 2.

### 9. Frontend — sidebar rendering & drag (`src/components/Sidebar/WorkspaceList.tsx`, `WorkspaceItem.tsx`, `CollapsedStrip.tsx`)

- Render via the §8 model: standalone rows as today; set blocks with the primary row then indented linked rows on a shared left **rail** (exact styling → `/frontend-design`).
- **Drag** (L61–164): operate on **blocks**, not members — dragging any set member moves the whole block; drop writes contiguous `position` values to all members. Disable cross-member drop *into* a set. Standalone workspaces and blocks are peers.
- **Context menu** (`contextMenuItems` L170): make role-aware using `workspaceGitStore` info —
  - main-worktree (primary or standalone): add `Add worktree…` → opens §10 dialog;
  - linked: add `Remove worktree…` (danger) → §11 confirm;
  - all: add `Workspace settings…` → §12 dialog.
- `CollapsedStrip` shows the rail/grouping affordance in the 44px collapsed mode too.

### 10. Frontend — Add worktree dialog (`src/components/AddWorktreeDialog.tsx`, new)

Reuse `NewWorkspaceDialog`'s launch-picker block (Decision 6 — agent picker). Fields:
- **Branch name** — required, no spaces, valid git ref (inline validation).
- **Folder** — defaults to `../<repo>.worktrees/<branch with / → ->`, auto-filled from branch until manually edited (the dirty-ref pattern from `NewWorkspaceDialog`); resolve relative→absolute against the primary root; **live absolute-path preview**; must not already exist.
- **Launch with** — terminal or agent (reused picker).
On submit: `worktrees.add(...)`, then add the returned worktree as a Workspace (snap-to-root — it *is* a root), **activate** it, and seed the focal pane's pending command = **setup commands ⧺ chosen agent command** (§13).

### 11. Frontend — Remove worktree confirm + live reconcile

- **Remove** (`WorkspaceList`): on `Remove worktree…`, call `worktrees.dirty(path)` first; render `ConfirmDialog` (danger) with **escalated copy when dirty** ("This worktree has uncommitted changes that will be permanently lost"). On confirm: tear down the workspace like delete (kill PTYs via `closeWorkspace`'s path, then `deleteWorkspace`), then `worktrees.remove(...)`; if it was active, focus the primary. The set auto-collapses on regroup.
- **Reconcile** (`onWorktreesChanged` in `App.tsx` / `workspaceStore`): debounced handler calls `worktrees.listRepoWorktrees` for the affected repo and diffs against current Workspaces in this Profile:
  - **new on disk, ≥1 member already a workspace** → create unopened, basename-named Workspace (eager add incl. bootstrap; **no** setup commands — Decision 11);
  - **gone from git's worktree list** → auto-`deleteWorkspace` (cascade);
  - **folder missing but still listed** → leave entry; it renders stale (no chip/group) via the empty summary.

### 12. Frontend — Workspace settings dialog (`src/components/WorkspaceSettingsDialog.tsx`, new)

Opened by `Workspace settings…` on any workspace. Fields:
- **Name** (rename — persists via `workspaces.update({ name })`; inline `Rename Workspace` menu item stays as the quick path).
- **Worktree setup commands** — a textarea, **only rendered for main-worktree workspaces** (gate on `isMainWorktree`); persists via `workspaces.update({ worktreeSetupCommands })`.

### 13. Frontend — setup-command execution (`src/stores/workspaceStore.ts`, `src/lib/pendingAgentRegistry.ts`)

Reuse the pending-command path (`setPendingAgent` → typed into the pane post-spawn). When Add worktree activates the new worktree's focal pane, build one command string: the primary's `worktreeSetupCommands` (split into lines, each newline-terminated) followed by the chosen agent's launch command (if any). The shell serializes them — setup runs first, agent after. Empty setup commands → behaves exactly like a normal create. (Doc-note: a non-terminating setup line, e.g. `npm run dev`, blocks the trailing agent — user's responsibility.)

## Testing

- **Rust** (`#[cfg(test)]`, `Connection::open_in_memory()` for DB; tests may shell to `git` for setup as the existing git tests do): `worktree_group_key`/`is_main_worktree` for main vs linked vs bare; `list_repo_worktrees` enumerates main + linked with branches; `add_worktree` new-branch / existing-branch / origin-tracking and folder-exists error; `remove_worktree` deletes files + keeps branch; `worktree_is_dirty`. Migration 011 round-trips the new column.
- **Frontend** (Vitest, `vi.mock("../ipc")`): `worktreeGrouping` — grouping at ≥2, primary-first, linked-by-`position`, block ordering by primary `position`, primary-less/bare → flat. Reconcile diff — add/remove/stale branches, the git-confirmed-only delete gate. Setup-command concatenation order (setup before agent).

## Risks / open implementation details

- **Orphaned branch on add failure**: branch-create succeeds, `worktree()` fails → delete the new branch in the error path, or the next add of the same name hits "already exists." Cover in `add_worktree`.
- **Group-key derivation** assumes git's standard `.git/worktrees/<name>` layout (no bound `commondir()`); exotic separate-gitdir setups may not group. Acceptable; note in code.
- **Watcher cost**: one per distinct repo in the active Profile. Per-repo (not per-workspace) bounds it; scoped to the active Profile only.
- **Auto-remove is destructive** (cascades tabs/layout/notes). The git-confirmed gate is the safety rail — the reconcile test must assert the "missing but still listed" branch does **not** delete.
- **Snap-to-root** changes behavior for the rare case of picking a subdirectory of a multi-worktree repo.
- **Locked worktrees** error on remove rather than force-pruning (lock honored); surface the error in the confirm.

## Suggested sequencing

1. Rust git layer + commands + summary fields + migration (§1–4) — independently testable.
2. Derived grouping module + sidebar render/drag (§8–9) — the visible core; no mutation yet.
3. Add / Remove / Workspace settings dialogs + setup-command execution (§10, §11-remove, §12–13).
4. Live-sync reconciler + watcher (§5, §11-reconcile) last — it builds on a working grouping + add/remove.
</content>
