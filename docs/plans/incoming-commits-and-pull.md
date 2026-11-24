# Incoming commits and Pull

## Context

The user wants to see when a Workspace's branch is behind its remote (someone pushed new commits),
and to bring those commits in with one click, without putting uncommitted work at risk.

Abundio never talked to a git remote before. All git reads are libgit2, in-process; the only network
traffic was the PR poller's `gh` calls. So knowing about new commits means adding a fetch.

## Language

See `GLOSSARY.md`: **Upstream**, **Incoming commits**, **Outgoing commits**, **Diverged**, **Pull**.
Not **Ahead commits**: those are measured against the base branch, not the Upstream.

ADR: `docs/adr/0066-incoming-commits-fetch-in-the-background-and-pull-only-fast-forwards.md`.

## Decisions

- **Behind what** — the current branch's Upstream (`@{u}`). Not the base branch.
- **Counts** — Incoming (↓N) and Outgoing (↑M). No push action.
- **Pull** — fast-forward only, after a fresh fetch. Never merges, rebases or stashes.
- **Diverged** — show ↓N ↑M, offer no Pull; the tooltip says to rebase or merge in a terminal.
- **Dirty tree** — allowed unless an incoming change touches a path with uncommitted work (staged,
  unstaged or untracked). Then Pull is refused and a dialog names the files.
- **Other refusals** — a merge / rebase / cherry-pick / revert in progress, detached HEAD, no Upstream.
- **Busy Agents** — if an Agent in the Workspace is Working, Pull asks to confirm, every time.
- **Mechanism** — `git` CLI for fetch and pull only; libgit2 stays for everything else. Prompts off
  (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `SSH_ASKPASS_REQUIRE=never`, ssh `BatchMode`
  unless the user configured their own ssh command), stdin closed, 60 s timeout. On a Host it runs
  there, through `host_api`.
- **When to fetch** — Opened workspaces only, once per repository (a Worktree set is fetched once),
  only the Upstream's remote:
  - on a timer: Settings ▸ "Check for incoming commits", Off or 5 / 15 / 30 / 60 min, default 30 min;
    every 2 h while the Window is in the background;
  - when the Window gains focus, if the last check is more than 5 minutes old;
  - on "Check for incoming commits" (Command palette, Commits header);
  - before every Pull.
  Off stops the timer and the focus fetch; the manual check and Pull still fetch.
- **Fetch failures** — quiet: the last counts stay, the tooltip says when the last check was and
  git's message. Nothing pops up.
- **Placement**
  - Left sidebar branch chip: ↓N only, click pulls.
  - Status bar branch segment: ↓N ↑M, click on ↓N pulls.
  - Commits section: an **Incoming** group above the Ahead commits, with Pull and Check now in its
    header. Rows behave like other commit rows.
  - Command palette: "Pull" and "Check for incoming commits" for the Active workspace.
- **Agent control** — nothing new. Agents run `git` in their own pane.

## Build

One branch (`incoming-commits`), ordered commits.

1. **Rust: upstream state** (`git_upstream.rs`, core). `compute_upstream_sync(cwd)` → `UpstreamState
   { name, remote, incoming, outgoing, incomingCommits (≤ 50), lastFetched }` or `None`. libgit2,
   cached by (HEAD, upstream tip). Added to `GitFetchBundle` (both bundle builders).
2. **Rust: fetch and pull.** `git_fetch_upstream(cwd)` runs `git fetch <remote>` with the prompt-off
   environment, at most one at a time per (repository, remote), and a second caller within 10 s
   gets the first one's result. Then pokes every git scheduler worker of the same repository, since
   a linked worktree's watch does not see the shared `refs/remotes`. `git_pull_ff(cwd)` fetches,
   re-checks (operation, detached, no Upstream, Diverged, overlap with uncommitted paths), then runs
   `git merge --ff-only @{u}`. Returns a `PullOutcome` (pulled / upToDate / refused{reason, files} /
   fetchFailed / failed), never an error for an expected refusal. Both are `host_api` commands
   (`hostApiCommands.ts`, `commandScope.ts`).
3. **Frontend: data.** `GitFetchBundle.upstream` into `workspaceGitStore` (per Workspace) and the
   `gitChangesStore` cache. `stores/incomingStore.ts`: per Workspace last check time, last error,
   checking / pulling flags. Setting `incomingCheckMinutes` in `settingsStore`.
4. **Frontend: fetch timer.** `hooks/useIncomingSync.ts` (in `App.tsx`): timer, focus, and the pure
   rules in `lib/incomingCommits.ts` (interval, focus staleness, which Workspaces to fetch).
5. **Frontend: Pull.** `lib/pull.ts`: busy-agent confirm, call, outcome → refusal dialog
   (`components/PullRefusedDialog.tsx`).
6. **Frontend: UI.** Sidebar chip, status bar, Commits section group, Command palette, Settings row.
7. **Docs.** `CLAUDE.md` module list.

## Tests

- Rust, with real temporary repos and a local bare remote: counts (none / incoming / outgoing /
  diverged / no upstream), fetch moves the counts, pull fast-forwards, pull keeps unrelated dirty
  files, pull refuses on overlap (tracked and untracked), on Diverged, mid-merge, detached.
- TS: the pure timer rules, the outcome → dialog text mapping, chip label / tooltip helpers.

## As built

- The refusal dialog lists the blocking files as text, with a "Show Git changes" button, rather than
  making each file clickable.
- The setting lives in Settings ▸ GitHub, under "Incoming Commits".
- Not yet verified in the running app against an ssh remote (the build sandbox has no ssh network);
  the tests use a local bare remote.
