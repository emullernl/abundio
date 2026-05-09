# Keep git/gh polling alive when the panel is collapsed (and for opened background workspaces)

## Context

Today, the git changes panel and PR section drive their own polling. The drawbacks:

- `GitChangesPanel.tsx:62, 69` early-return on `!panelOpen`, tearing down the `fs-change` / `git-change` listeners and the initial `fetchChanges` call.
- `PullRequestsSection.tsx` is not rendered at all when the panel is collapsed, so its 60s `setInterval` never runs.

Side effects:

1. The sidebar branch chip and change counts (driven by `useWorkspaceGitStore.byWorkspaceId`) stop updating when the panel is collapsed, because the only writers are `gitChangesStore.fetchChanges` / `refreshChanges`, which only run while the panel is open.
2. PR-state-change notifications from `prStore.subscribe` (`prStore.ts:175–273`) stop firing because they only run as a side-effect of fresh `gh` polling on the active workspace.
3. **Opened background workspaces** (members of `usePtyActivityStore.openedWorkspaceIds` other than the active one — i.e. workspaces the user has activated this session and not closed) never get any git refresh, so their sidebar chips go stale as soon as the user switches away.

User wants polling to keep running for the active workspace when the panel is collapsed, and for opened background workspaces too, with a slower gh cadence when the panel is collapsed.

## Approach

Lift git data polling out of `GitChangesPanel` and gh polling out of `PullRequestsSection` into a single top-level hook `useGitDataSync` that runs from `App.tsx`. The panel components become pure consumers of `gitChangesStore` / `prStore`. The hook drives:

- **Per opened workspace** — one set of throttled `fs-change` + `git-change` listeners (lifecycle pattern of `useFileReloadWatcher`). Each callback reads `useWorkspaceStore.getState().activeWorkspaceId` *fresh* on every event and routes:
  - **Active workspace** → existing `useGitChangesStore.fetchChanges` (on git-change) / `refreshChanges` (on fs-change). These already update both stores.
  - **Background workspace** → new fingerprint-gated `useWorkspaceGitStore.refreshWorkspace(workspaceId, cwd)` on fs-change; full `fetch(workspaceId, cwd, baseBranch)` on git-change (rare and gated by `is_meaningful_git_change` in Rust).
- **Active-workspace gh polling** — single `setInterval` whose period adapts to `panelOpen`: 60s open, 300s collapsed. Owned entirely by the hook; `PullRequestsSection` no longer drives any polling.
- **Active-workspace switch** — clear `gitChangesStore` + `prStore` singletons, kick off `fetchChanges` + `checkGhStatus → fetchReviewPrs + fetchMyPrs` immediately, reset the gh interval.

Background workspaces are not gh-polled per repo; the existing `*-all` cross-repo gh queries (verified at `gh_commands.rs:526, 573` — they use `gh search prs --review-requested=@me` / `--author=@me` with no repo filter) cover other workspaces' PRs through the active-workspace polling.

`prStore` and `gitChangesStore` stay singleton (active-workspace data). Per-workspace data goes through `useWorkspaceGitStore`.

## Files to modify / create

### New: `src/hooks/useGitDataSync.ts`

Top-level hook mirroring `src/hooks/useFileReloadWatcher.ts:62` lifecycle pattern. Reads:

- `useWorkspaceStore` → `workspaces`, `activeWorkspaceId`
- `usePtyActivityStore` → `openedWorkspaceIds`
- `useGitChangesStore` → `panelOpen`, `fetchChanges`, `refreshChanges`, `clear`
- `usePrStore` → `checkGhStatus`, `fetchReviewPrs`, `fetchMyPrs`, `clear`
- `useWorkspaceGitStore` → `fetch`, `refreshWorkspace` (new, see below)

Three effects:

**1. Per-opened-workspace event subscriptions.** Driven by diffing `openedWorkspaceIds` × `workspaces` against an `activeRef.current: Map<workspaceId, ActiveWatcher>` (same shape as `useFileReloadWatcher`'s `Map<root, ActiveWatcher>`, but keyed by workspaceId since two workspaces can share a root and we need per-workspace routing). For each opened workspace:

- Register `fs.onFsChange(cwd, ...)` and `fs.onGitChange(cwd, ...)` with leading + trailing throttle at 500ms (verbatim port of `GitChangesPanel.tsx:73–127`: separate `lastFsAt`/`lastGitAt` timestamps + trailing-edge timers + `cancelled` flag).
- On every event, read `useWorkspaceStore.getState().activeWorkspaceId` fresh, then:
  - If `workspaceId === activeId` → `useGitChangesStore.getState().refreshChanges(cwd)` (fs) or `fetchChanges(cwd, baseBranch)` (git).
  - Else → `useWorkspaceGitStore.getState().refreshWorkspace(workspaceId, cwd)` (fs) or `fetch(workspaceId, cwd, baseBranch)` (git).

Also unmount-cleanup effect with `[]` deps that drains `activeRef.current` (mirrors `useFileReloadWatcher.ts:120–130`).

**2. Active-workspace switch + initial-fetch effect.** Depends on `[activeWorkspaceId, activeCwd]`. On change:

- `useGitChangesStore.getState().clear()` (replaces `GitChangesPanel.tsx:56–58`).
- `usePrStore.getState().clear()` (replaces `PullRequestsSection.tsx:36–38`).
- `useGitChangesStore.getState().fetchChanges(cwd, baseBranch)` (replaces `GitChangesPanel.tsx:61–64`).
- `usePrStore.getState().checkGhStatus(cwd)` then on success `fetchReviewPrs(cwd)` + `fetchMyPrs(cwd)` (replaces `PullRequestsSection.tsx:41–56`).
- Also resets the gh-polling interval (see effect 3 — it watches the same deps, so rebuild is automatic).

**3. Active-workspace gh polling.** Single `setInterval` whose period flips with `panelOpen`. Depends on `[activeWorkspaceId, activeCwd, panelOpen, ghStatus.ok]`:
- `panelOpen=true` → 60s.
- `panelOpen=false` → 60s.
- Each tick fires `fetchReviewPrs(cwd) + fetchMyPrs(cwd)`. Skips if `!ghStatus.ok`.
- Cleared and rebuilt whenever any dep changes.

### Modify: `src/stores/workspaceGitStore.ts`

Add fingerprint-gated `refreshWorkspace(workspaceId: string, cwd: string)` mirroring `gitChangesStore.refreshChanges` (`gitChangesStore.ts:147–175`):

- Maintain `fingerprintByWorkspaceId: Record<string, string>` on the store (cleared by `remove(workspaceId)`).
- Call `git.statusFingerprint(cwd)`. Bail if unchanged.
- On change: call `git.changedFiles(cwd, baseBranch)` only (skip `branchInfo` — branch can only change via `git-change` which goes through `fetch`).
- Update `byWorkspaceId[workspaceId]` with new `changedFileCount`/`additions`/`deletions`, leave `currentBranch`/`isGitRepo` as-is.
- Catch and swallow errors (this is a background refresh).
- `remove(workspaceId)` (`workspaceGitStore.ts:118–123`) must also delete `fingerprintByWorkspaceId[workspaceId]`.

### Modify: `src/components/GitChanges/GitChangesPanel.tsx`

- Delete the `clear()` effect at lines `56–58`, the initial-fetch effect at `60–64`, and the fs/git listener effect at `66–129`. The hook now owns all of these.
- Component becomes a pure consumer of `gitChangesStore`. Manual refresh button (`handleRefresh`, line 155) stays — it directly calls `fetchChanges`.
- Collapsed-strip early return (line 171) and the rest of the rendering logic are unchanged.

### Modify: `src/components/GitChanges/PullRequestsSection.tsx`

- Delete the gh-polling `useEffect`s at `36–38` (clear-on-cwd), `41–44` (status check), `47–50` (review fetch), `53–56` (my-prs fetch), and `59–72` (60s interval). The hook now owns these.
- Manual refresh button (`handleRefresh`, line 74) stays — it directly calls `checkGhStatus` + fetches.
- Drop the `REFRESH_INTERVAL` constant.
- Component becomes a pure consumer of `prStore`.

### Modify: `src/App.tsx`

Add `useGitDataSync()` next to `useFileReloadWatcher()` at line 160.

## Reuse / existing utilities

- `useFileReloadWatcher` (`src/hooks/useFileReloadWatcher.ts:62`) — pattern for per-opened-workspace effect lifecycle. `Map<key, ActiveWatcher>` ref + `diffRoots`-style set diff applies cleanly.
- `useWorkspaceGitStore.fetch` (`src/stores/workspaceGitStore.ts:27`) — already does per-workspace `git.changedFiles` + `git.branchInfo`, writes into `byWorkspaceId`, persists `lastBranch` to SQLite. Reused as-is for git-change events on background workspaces.
- `useGitChangesStore.fetchChanges` / `refreshChanges` (`src/stores/gitChangesStore.ts:78, 147`) — reused as-is for active workspace; both write into both `gitChangesStore` and `workspaceGitStore`.
- `usePrStore.checkGhStatus` / `fetchReviewPrs` / `fetchMyPrs` (`src/stores/prStore.ts:64, 79, 104`) and the notification subscriber at `prStore.ts:175–273` — reused as-is. Notifications still fire correctly because polling stays on the same store.
- `fs.onFsChange` / `fs.onGitChange` (`src/lib/ipc.ts:204, 227`) — reused as-is. The Rust watcher (`src-tauri/src/file_watcher.rs`) is per-root and already kept alive for every opened workspace by `useFileReloadWatcher`. Multiple subscribers per root are fine — `ipc.ts` filters by root in JS.

## Cadence summary

| Workspace | Panel state | Git refresh | gh refresh |
|---|---|---|---|
| Active | Open | event-driven (fs + git events, 500ms throttle) → `fetchChanges`/`refreshChanges` | 60s (hook-owned interval) |
| Active | Collapsed | event-driven (fs + git events, 500ms throttle) → `fetchChanges`/`refreshChanges` | 60s (hook-owned interval) |
| Opened background | (any) | event-driven (fs → fingerprint-gated `refreshWorkspace`; git → full `fetch`) | none (cross-repo `*-all` views cover via active polling) |
| Never-activated | (any) | none | none |

"Opened background" = workspace ID is in `usePtyActivityStore.openedWorkspaceIds` (user activated it this session and hasn't closed it) but is not the active workspace. Workspaces shown in the sidebar that the user has not activated this session do not appear in this set and are not polled.

## Verification

- `pnpm check` and `pnpm test` clean.
- `cd src-tauri && cargo check` clean (no Rust changes expected).
- Extend `src/stores/__tests__/workspaceGitStore.test.ts` with coverage for `refreshWorkspace`: bails on unchanged fingerprint, updates counts on change, handles errors silently, `remove` clears fingerprint cache.
- Manual:
  1. `pnpm tauri dev` in a multi-workspace setup with at least two opened workspaces, one a git repo with a remote that has open PRs.
  2. With panel open: edit a file in active workspace → file appears in changes list within ~500ms (regression check).
  3. Collapse panel (`Cmd+Shift+G`). In a terminal in the active workspace, `git checkout -b test-branch` then create a file. Reopen panel → branch chip and changes already up to date (no loading spinner flash).
  4. Switch to a background workspace's terminal (without activating it via the sidebar), edit a file there. Sidebar chip's change count updates within ~1s without activating that workspace.
  5. Confirm gh cadence by watching console / network: panel open → `gh review-requests` every ~60s; collapsed → every ~300s.
  6. PR notifications: blur the window past threshold, have someone request review on one of your PRs → notification still fires while panel is collapsed.
  7. Workspace switch: switch active workspace. Old workspace's listener now routes to background path (next fs event in old workspace updates only its sidebar chip, not the panel). New active workspace's panel populates from a fresh `fetchChanges`.

## Notes on existing module-level state

`gitChangesStore.ts:8–9` (`fetchGeneration`, `lastFingerprint`) and the active-workspace assumption in `fetchChanges` / `refreshChanges` (which write to `useWorkspaceStore.getState().activeWorkspaceId` rather than to a passed-in workspaceId) are preserved by this design — the hook only calls these for the active workspace. Background workspaces go through `workspaceGitStore.refreshWorkspace` which takes `workspaceId` explicitly.
