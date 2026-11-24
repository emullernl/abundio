---
status: proposed
---

# Incoming commits: fetch in the background with the git CLI, and Pull only fast-forwards

Abundio never talked to a git remote, so it could not tell when someone had pushed to a Workspace's branch. We decided that Abundio fetches the **Upstream** of every Opened workspace in the background, counts **Incoming** and **Outgoing commits**, and offers a **Pull** that only fast-forwards. Fetch and Pull run the `git` CLI as a subprocess, while every other git read stays in libgit2.

- **Why the CLI, when the hot path left it for libgit2.** The move to libgit2 (`git_libgit2.rs`) was about speed: three `git` processes after every file change stalled the UI. A fetch is rare, waits on the network, and runs off the UI thread, so process start-up does not matter. The CLI uses the user's own ssh agent, credential helpers and hooks, which libgit2 would have to rebuild and often gets wrong. Both run with prompts off (`GIT_TERMINAL_PROMPT=0`, ssh `BatchMode`), so a fetch that needs a password fails quickly instead of hanging. On a Host it runs there, with the Host's credentials.
- **What the CLI may run.** Unlike libgit2, the CLI acts on a repository's own config (`core.sshCommand`, hooks, `core.fsmonitor`), so opening a folder from an untrusted source could run commands with no user action. A background fetch therefore runs only in a repository that has fetched before (it has a `FETCH_HEAD`); anything else waits for Check now or Pull. Every fetch also runs with `core.hooksPath=/dev/null` and `core.fsmonitor=false`, and passes the remote after `--`. A Pull is a user action and keeps the user's hooks, as `git pull` in a terminal would; it reports a Pull whose branch moved even if a `post-merge` hook then failed.
- **When.** On a timer (default every 30 min, every 2 h while the Window is in the background, or Off), when the Window gains focus, when the user asks (Check for incoming commits), and before every Pull. Opened workspaces only, and once per repository (a successful fetch is reused for 10 s; a failed one never is), so a Worktree set is fetched once. Only the remote the Upstream lives on is fetched. A failed fetch keeps the last count and says why in the tooltip; it never pops anything up.
- **Pull never merges, rebases or stashes.** It fast-forwards or it refuses. A Diverged branch shows ↓N ↑M and offers no Pull. Uncommitted work is allowed whenever git's own fast-forward allows it, which means no incoming change touches a file the user has edited. When git refuses, a dialog names the blocking files. Merging, rebasing and stash conflicts are left to a terminal, as conflict resolution already is (ADR-0029).
- **Agents.** Pull asks for confirmation when an Agent is Working in the Workspace's folder, every time. Agent control gets no pull verb: Agents run `git` in their own pane.

## Considered Options

- **libgit2 for fetch and pull.** Rejected: credential handling (ssh agent, osxkeychain, the `gh` helper) would be ours to maintain, and it fails where `git` works.
- **Rebase or plain `git pull`.** Rejected: both can stop halfway in a conflict state inside a folder an Agent is editing.
- **Auto stash and reapply.** Rejected: a failed reapply leaves conflict markers in files an Agent may be editing right now.
- **Fetch only when asked.** Rejected: then the signal is only as fresh as the user's last `git fetch` in a terminal.
