# Dirty workspace marker in the Left sidebar

## Context

The user wants to see, from the Left sidebar, which git Workspaces hold uncommitted work. The sidebar
already draws a change stat (`3F +12 -4`) under the branch chip, but it answers a different question:

- It sums **every** Section of the Git changes tab, including `against_base` (committed history), so a
  clean branch with commits ahead of its base looks "changed".
- It is drawn only for Workspaces opened this session.
- Its file count is `files.length` — one row *per Section*, so a file committed on the branch and
  edited again counts twice.

## Language

See `CONTEXT.md`: **Dirty workspace**, **Dirty marker**, **Branch stat**, and the Dirty-marker
sentence in **Hidden rollup**.

## Decisions

- **Meaning** — dirty = at least one untracked, unstaged, staged or conflicted path (`git status`).
  Commits ahead of base never count. Non-git Workspaces are never dirty.
- **Scope** — every git Workspace, opened or not. Opened: live, from the per-workspace
  `GitScheduler` bundle. Not opened: the batched `git_workspaces_summary`, which gains `isDirty`.
- **Refresh for unopened Workspaces** — whenever the batch already runs (Workspace list change) **and**
  when the Window regains focus. No timer: agents run in opened Workspaces, which are already live.
- **Shape** — a **hollow ring** in `--warning`, inside the branch chip, only while dirty. Hollow
  because a filled circle in the sidebar is a status badge (amber = Working). Full colour even on the
  dimmed chip of an unopened Workspace.
- **Folded set** — the Hidden rollup draws a ring when any hidden member is dirty; its member tooltip
  marks which ones.
- **Narrow sidebar** — a ring on the bottom-right corner of the Terminal rollup cell, meaning "this
  Workspace or a hidden member is dirty" (mirrors the Hidden-rollup badge at the Agent cell's top-right).
- **Tooltip** — opened: `Uncommitted: 2 staged · 3 unstaged · 1 untracked` (+ `· 1 conflicted`), by
  distinct path per Section. Unopened: `Uncommitted changes`. No click action of its own.
- **Branch stat** — kept as branch size against base, now with a `vs <base>` tooltip, and its file
  count becomes **distinct paths**.
- **Surface** — sidebar only. No Overview bar or Status bar change.
- No ADR: every choice is cheap to reverse.

## Design

### Rust

- `git_libgit2`: split `worktree_is_dirty(cwd)` into `worktree_is_dirty_in(&Repository)` plus the
  existing wrapper, so the batch reuses the repository it has already discovered. One definition of
  dirty for the marker and the Remove-worktree confirmation.
- `git_commands::WorkspaceGitSummary` gains `is_dirty: bool`, set in `compute_workspace_git_summary`
  (false when not a repo).

### Frontend state

Dirtiness lives in its **own map** on `workspaceGitStore` — `uncommittedById` — not in
`WorkspaceGitInfo`. Five call sites replace `WorkspaceGitInfo` wholesale via `setInfo`; a field there
would be clobbered, the same reason `worktreeFacts` is separate.

```ts
type UncommittedBreakdown = { staged; unstaged; untracked; conflicted }; // distinct paths
type Uncommitted = { dirty: boolean; breakdown: UncommittedBreakdown | null };
```

`breakdown !== null` means **live** (derived from a scheduler bundle / active fetch).

- `setLiveUncommitted(id, files)` — from `applyBundle` and the active-workspace `fetch`.
- `endLiveUncommitted(id)` — from `useGitDataSync` when a scheduler stops: keeps `dirty`, drops
  `breakdown`, so the next batch may update it.
- `syncWorktreeFacts` writes `{ dirty: isDirty, breakdown: null }` **only for entries that are not
  live**. Skipping live entries avoids a race where a batch computed before an edit lands after the
  bundle that reported it.
- Non-git transitions (`applyError` with `notGitRepo`) remove the entry.
- Setters keep the object reference when nothing changed, so memoised rows don't re-render.

Pure helpers (tested): `uncommittedOf(files)`, `branchStatOf(files)` (distinct paths),
`uncommittedTooltip(u)`.

### Triggers

`useWorktreeSync` subscribes to `addWindowFocusListener`; on focus gain it re-runs
`syncWorktreeFacts` for the Window's Workspaces (skipped while a focus refresh is already in flight).

### UI

- `WorkspaceItem`: ring inside the branch chip after the name (`data-dirty-marker`), `title` = tooltip.
  Branch stat gets `title="vs <base>: N files, +A −D, including uncommitted"` (base =
  `workspace.baseBranch`, else "the default branch").
- `useHiddenRollup` gains `dirty: boolean`; dirty members' tooltip lines end in `· uncommitted`.
  `WorkspaceItem` draws the ring after the hidden count.
- `CollapsedStrip`: ring at the Terminal cell's bottom-right when own **or** hidden dirty.
- Shared `DirtyMarker` component so all three placements look the same.

### Demo

`fixtures.workspaceSummary` sets `isDirty` from the fixture's non-`against_base` files, and uses
distinct paths for its count.

## Commits (one branch)

1. Plan + glossary.
2. Rust: `is_dirty` in the workspace summary (+ tests).
3. Store: `uncommittedById`, helpers, distinct-path Branch stat, bundle/sync wiring, focus refresh (+ tests).
4. UI: Dirty marker in chip, Hidden rollup and narrow strip; Branch stat tooltip; demo fixture (+ tests).
