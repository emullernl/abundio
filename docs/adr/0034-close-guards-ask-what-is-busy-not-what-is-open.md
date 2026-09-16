---
status: accepted
---

# Close guards ask what is busy, not what is open

Abundio's close confirmations had drifted apart. The **Unload workspace** guard tested real work (`state === "active" && detectionMode === "agent"`, or a running shell command), but **Close window** and **Quit** tested only `openedWorkspaceCount > 0` while their copy claimed *"running agents and terminal processes"* — so they fired on every quit regardless, and said something that was usually untrue. A prompt you always get is a prompt you stop reading, which is exactly backwards for the one dialog that should be believed. We give all three a single shared predicate, the **Busy PTY**: an agent-mode PTY that is Working, or a shell-mode PTY with a command running. No Busy PTY, no prompt.

- **Quit is stricter: Busy *or* a Waiting agent.** Unload closes one Workspace the user is looking at and chose to close, so a Waiting agent — blocked on the user, not mid-turn — should not stand in the way. Quit takes down every Window, including ones the user cannot see, and a Waiting agent holds finished work with a question on it. That is the costliest thing to lose, not the cheapest. Documented in plain words rather than given a second coined term, since it has exactly one call site.
- **The dialogs now name what is actually busy** — "2 agents working, 1 waiting on you" — which is only worth saying because the predicate is now true.
- **Quit needs cross-window counts, so each Window mirrors a `{ working, waiting, commands }` tuple to Rust, sent only when the tuple changes.** Counts are far stabler than status transitions: ten panes flickering between Idle and Working move the number only when one crosses a boundary. Close window reads its own store directly and needs none of this.
- **Pane close is left alone.** It already confirms unconditionally, so nothing can be lost silently there.
- **The tab guard is left alone.** It prompts when a tab holds *any* agent PTY, even an idle one — deliberately stricter than Busy, because closing a tab throws away an agent's session whether or not it is mid-turn.

## Considered options

- **Keep the count-based predicates and only fix the wording.** Honest, but leaves the every-quit prompt that trained the user to dismiss it. Rejected.
- **Always confirm, with precise copy when busy and generic copy when not.** Keeps a safety net, keeps the training-to-dismiss problem with it. Rejected — see Consequences for why the net is not load-bearing.
- **One predicate everywhere, Waiting never blocking.** One test table instead of two, but it lets Cmd+Q silently kill an agent that is waiting on an answer. Rejected.
- **Pull counts from each Window when Quit is pressed** instead of mirroring them. No background traffic, but it needs a round-trip to every webview inside a menu handler, and a wedged Window would either hang the menu or be timed out and assumed idle. Rejected.

## Consequences

- **A quiet Abundio now quits without asking.** Ten idle Workspaces, Cmd+Q, gone. This is safe because state is restored: `saveAllSnapshots()` persists scrollback, `windows.json` restores the Windows, and Workspaces and layouts come back from SQLite. Unsaved *editor* files — the loss relaunching cannot undo — keep their own `SaveConfirmDialog`, which fires independently and takes precedence.
- **A foreground program that emits nothing is invisible to the guard.** `isShellCommandRunning` is driven by shell-integration markers and the process-monitor fallback; a paused REPL, `less`, or an idle ssh session may not register, and will die silently. Accepted.
- **`isShellCommandRunning` is deleted.** The guards used to read a module-level `Map` written from `terminalManager`, while the icon read the status machine — two pieces of state for one idea, with nothing keeping them in step, so a row could show cyan Working while Quit said nothing was busy. It turned out not to be a second source of truth but a stale duplicate: the reducer already holds `shellCommandRunning` in its own state and already suppresses the idle backstop while it is true (`reduceTick`), so a long *silent* build keeps counting as busy. We project that field into `PtyActivityEntry` and delete the map, making **Busy PTY** a pure function of one entry — table-testable, reactive, and identical for the icon and the guard. The projection's skip-write-when-unchanged comparison must include the new field, or the store would go stale while the reducer stayed fresh — which is the bug being deleted.
- Dock-icon Quit and OS shutdown still route through `ExitRequested` after Windows tear down and remain ungated, as before (see ADR-0007).
- `profileStore.switchProfile` and `workspaceStore.removeWorktreeWorkspace` still call `closeWorkspace` directly, bypassing the unload guard. Unchanged here, but now the only remaining count-based confirmation is the profile switch.
