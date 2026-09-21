# Branch commits — an Anchored section in the Right sidebar

Decided in a grilling session on 2026-09-21. Terms (**Anchored section**,
**Branch commits**, **Commit diff pane**) are defined in `CONTEXT.md`.

## What it is

A collapsible section between the tab content and Pull Requests, visible on
every tab, listing the commits on the Active workspace's branch that its base
branch does not have yet (`merge-base..HEAD`, same base as the `against_base`
Section).

- Rows: subject, author initials, relative time. Tooltip: hash, full name,
  date, full message.
- Newest 200 only; header carries the true count and the list ends with
  "N more not shown".
- Merge commits listed along with the commits they brought in.
- Empty range: "No commits ahead of <base>". Non-git: "Not a git repository".
- Clicking a row expands it to the files the commit touched (first parent vs
  commit). Clicking a file opens a read-only **Commit diff pane**, keyed
  `diff@<sha>:<path>`, never refreshed by the file watcher and never sharing a
  pane with the live `diff:<path>` pane.
- Right-click: Copy hash, Open on GitHub (disabled when there is no GitHub
  remote or the commit is on no remote branch). No git writes.
- Layout: two dividers (above Commits, above PRs). Collapse per-Window; sizes
  global. First run: expanded, carved out of the tab content's share.

## Commits (one branch: `feat/branch-commits`)

1. **Rust: commit data.** `git_libgit2::compute_branch_commits_sync` (revwalk
   `HEAD ^base`, cap 200, `onRemote` via a second walk hiding every
   `refs/remotes/*`), `commit_files_sync`, `commit_file_diff_sync`. Add
   `branch_commits` to `GitFetchBundle` (best-effort, `None` when the base
   cannot be resolved) in both the scheduler and `git_fetch_bundle`. New IPC
   `git_commit_files`, `git_commit_file_diff`. Tests on temp repos.
2. **Frontend data.** Types + `git` IPC wrappers; `gitChangesStore` carries
   `branchCommits` in its per-workspace cache and singleton. Demo fixtures.
3. **Commit diff pane.** `lib/commitDiffKey.ts` (build/parse the key),
   `explorerStore.openCommitDiff`, `FilePane` loads content for a restored
   pane with none, and the real-path derivations learn the new key.
4. **Layout.** `windowUiStore.commitsSectionCollapsed`,
   `settingsStore.rightSidebarCommitsShare` (global, broadcast like the PR
   ratio), a pure `rightSidebarShares` helper for the three-way split, and a
   second `SectionDivider`.
5. **UI.** `CommitsSection` (header, rows, expansion, menu) with pure helpers
   (`initials`, `relativeTime`, `commitMenuEntries`) in `lib/`.
