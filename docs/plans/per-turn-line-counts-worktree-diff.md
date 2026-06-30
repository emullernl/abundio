# Per-Turn line counts from a working-tree diff

> Implements ADR-0021. Replaces the net-vs-base-branch line-count delta (which recorded +0 −0 for most edit Turns) with a per-Turn working-tree diff.

## Context

Each agent **Turn** stores `lines_added` / `lines_deleted` in `agent_turn`, shown in the Statistics overlay. Many turns recorded **+0 −0** because the count was a delta of two *cumulative diff-vs-base-branch* totals, floored at zero (`src/lib/agentTurnTracker.ts::writeRecord`):
```ts
linesAdded = Math.max(0, gitEnd.added - t.gitStart.added);
linesDeleted = Math.max(0, gitEnd.deleted - t.gitStart.deleted);
```
Net-vs-base reads 0/0 whenever a turn reverts/cleans up (floored), re-edits lines an earlier turn already diverged from base (the dominant case), or churns lines that cancel.

**Fix:** compute each turn's lines as the **net effect of the turn on the worktree** — snapshot the worktree to a git tree at turn start and turn end, then `diff_tree_to_tree` the two and use its insertions/deletions/files. Agent-agnostic (all six agents, pure libgit2), captures in-place edits / reverts / refactors / new files, no flooring.

## Decisions (see ADR-0021)

1. Metric = **turn-start↔turn-end net effect** (across-turn re-edits count; within-turn redos collapse). Keystroke churn (per-agent hooks) out of scope.
2. **Start-snapshot race accepted & documented** — begin snapshot is fire-and-forget at `"active"`; rare, fails safe.
3. **Drop the finalize `fetchBundle` + `gitStart` cache read**; `git_*_start/end` provenance columns written NULL (no migration); tracker sheds `workspaceGitStore`/`cachedGitSnapshot`.
4. Genuine no-op turns correctly read `+0 −0` (distinct from `unmeasured`).
5. **Overlap untouched** — `contaminated → NULL`, keyed on `workspaceId`.
6. **Whole-repo snapshot** (no pathspec scoping; future refinement). **Renames** = delete+add (parity). **New files = `git add -A` semantics**: untracked non-ignored files counted as additions (true line counts, no size cap, binaries 0 lines/1 file); ignored files excluded.

**Validated:** `git2 = 0.19` (libgit2 1.8.1). `add_all(["."], DEFAULT, None)` = `git add -A`. **Never calling `index.write()` leaves `.git/index` untouched** — only loose tree/blob objects (dedup'd, GC'd). Cost ≈ a `git status`-class working-tree stat-walk (proportional to non-ignored file count) plus hashing of only the changed/new files — run twice per Turn on a blocking thread, comparable to `compute_status_fingerprint_sync`. Works for linked worktrees, unborn branches, non-git dirs (`Ok(None)`). Concurrent snapshots safe.

## Implementation

1. **`src-tauri/src/git_libgit2.rs`** — add `IndexAddOption`, `Oid` to the `git2` import; add `snapshot_worktree_tree(cwd) -> Result<Option<String>, AbundioError>` (in-memory index seeded from HEAD or `clear()` for unborn, `add_all(["."])`, `write_tree_to`, **no `index.write()`**) and `diff_tree_stats(cwd, start_oid, end_oid) -> Result<TreeDiffStats, AbundioError>` (`diff_tree_to_tree(...).stats()`).
2. **`src-tauri/src/git_commands.rs`** — `pub struct TreeDiffStats { additions, deletions, files }` (serde camelCase); commands `git_snapshot_worktree(cwd)` and `git_diff_trees(cwd, start_oid, end_oid)` (single `spawn_blocking`, like `git_changed_files`).
3. **`src-tauri/src/lib.rs`** — register both in `invoke_handler!`.
4. **`src/lib/ipc.ts`** — export `interface TreeDiffStats`; add `git.snapshotWorktree` / `git.diffTrees`. **`src/lib/demo/mockInvoke.ts`** — `git_snapshot_worktree → null`, `git_diff_trees → {additions:0,deletions:0,files:0}`.
5. **`src/lib/agentTurnTracker.ts`** — remove `gitStart`/`cachedGitSnapshot`/`workspaceGitStore`; `OpenTurn` gains `startTreeOid` + `startTreePromise`; begin fires `git.snapshotWorktree` fire-and-forget; `writeRecord` drops `fetchBundle`, NULLs `git_*_start/end`, computes lines from `diffTrees(startOid, endOid)` (no `Math.max`); preserves `contaminated → NULL` and non-git → NULL.
6. **`src/components/Statistics/StatsSummaryCards.tsx`** — "Net lines" → "Lines changed" / "changed during turns" / new tooltip.
7. Schema — none. Docs — DONE (ADR-0021, ADR-0018 annotation, CONTEXT.md).

## Tests

- **`git_libgit2.rs`**: temp-repo helper (mirror `git_commands.rs`'s); tracked edit; revert/net-negative (deletions>0, additions==0); new untracked file (counts) + `.gitignore`'d (0); deleted tracked file; **index-untouched invariant** (`.git/index` bytes identical); unborn branch; non-git → `Ok(None)`; linked worktree; binary (0 lines/1 file).
- **`agentTurnTracker.test.ts`**: `beforeEach` stub `snapshotWorktree`/`diffTrees`; rewrite the "floors net-negative deltas at 0" test → `diffTrees → {additions:0,deletions:5,files:1}`, assert `linesDeleted===5`/`linesAdded===0`; overlap test `gitAddedEnd` `8 → null`.

## Verification

`cd src-tauri && cargo test`, `pnpm test`, `pnpm check` green. Manual: `pnpm tauri dev`, drive an agent through (a) create file, (b) rewrite lines, (c) revert — overlay shows non-zero direction-correct counts (revert shows deletions); `git status`/staging unchanged after turns.
