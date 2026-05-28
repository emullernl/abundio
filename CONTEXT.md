# Abundio

GPU-accelerated terminal multiplexer. The user opens one or more application Windows; each Window shows one Profile; each Profile owns a set of Workspaces; each Workspace runs its own pane layout and PTY processes.

## Language

**Window**: A single OS-level application window (Tauri `WebviewWindow`). Windows come in two kinds:
- **Profile-bound window**: owns exactly one **Profile** (one-to-one, exclusive — a Profile is open in at most one such Window at a time). Created via File → New Window with Profile. Appears in `windows.json` for restoration across launches and counts toward the "last-window-closing quits the app" rule. Labels follow the pattern `main` (the first window) or `window-<uuid>` (additional windows).
- **Auxiliary window**: serves a global purpose unrelated to any single Profile. Currently only the **Settings window**. Does not own a Profile, is not persisted in `windows.json`, and does not count toward the quit rule. Uses a stable singleton label (`settings`).

The label is the stable identifier across launches — both Abundio's own `windows.json` and `tauri-plugin-window-state` key per-window data by it.
_Avoid_: viewport, app instance, frame; do **not** use "window" to mean a **Pane** (see Pane).

**Settings window**: The singleton auxiliary **Window** labelled `settings`. Opens (or focuses if already open) via File menu, Cmd+,, or the "Manage Profiles…" deep-link. Edits the *global* profile registry — has no active Profile of its own. Theme, font, and agent changes here propagate live to all open Profile-bound windows via a Tauri event broadcast. See ADR-0008.
_Avoid_: preferences window, options dialog.

**Profile**: A top-level grouping of Workspaces — a named bundle the user uses to organize unrelated bodies of work (e.g. "Work", "Personal"). Each **Workspace** belongs to exactly one Profile and cannot be moved between Profiles after creation. The only per-Profile data today is the Workspace list; appearance, custom agents, env vars and GitHub identity remain global. Scope is intentionally narrow so the term may broaden later. A Profile is bound to at most one **Window** at any moment.
_Avoid_: space, group, namespace, context

**Active profile**: The single Profile currently shown in a given Window. Per-Window singleton — Window A's active profile is independent of Window B's, but a Profile cannot be active in two Windows at the same time. Switching Profile closes every Opened workspace in the previous Active profile of *that Window* (with a confirm dialog when any are open). Persisted across restarts per-Window.
_Avoid_: current profile, selected profile, focused profile

**Default profile**: The Profile created at migration time to host pre-existing Workspaces. After migration it has no permanent specialness: it can be renamed, and it can be deleted as long as another Profile exists. The system invariant is "at least one Profile must always exist" — not "the Default must exist".
_Avoid_: primary profile, root profile, main profile

**Workspace**: A folder-bound container with its own pane layout, tabs, and PTY processes. Belongs to exactly one **Profile**.
_Avoid_: project, folder

**Active workspace**: The single Workspace currently selected and visible to the user *within a Window*. Per-Window singleton (`useWorkspaceStore.activeWorkspaceId` — each Window has its own JS context and so its own store instance).
_Avoid_: selected workspace, current workspace, focused workspace

**Opened workspace**: A Workspace the user has activated at least once *in its Window* and has not closed. Tracked per-Window by `usePtyActivityStore.openedWorkspaceIds`. PTY processes and file watchers stay alive for these even when not the Active workspace.
_Avoid_: loaded workspace, mounted workspace

**Background workspace**: An Opened workspace that is not currently the Active workspace. Not a separate state — derived as `openedWorkspaceIds \ {activeWorkspaceId}`.

**Pane**: A leaf slot within a Workspace tab. Panes form a recursive binary split tree (`PaneNode`). A Pane is one of: a **terminal pane** (holds a PTY), a **file pane** (holds an open file), or a **preview pane** (renders another pane's content).
_Avoid_: panel, window, split

**File pane**: A Pane that holds one open file — rendered as a Monaco editor (text), diff view, or image viewer depending on file type. Identified by its `filePath`.
_Avoid_: editor, viewer

**Preview pane**: A Pane that renders a live, read-only rendering of its **source pane**'s markdown buffer — including Mermaid diagrams. Owns no file of its own; it mirrors. Created beside a file pane when a markdown file is opened.
_Avoid_: render pane, markdown viewer

**Source pane**: The file pane a preview pane is bound to (`sourcePaneId`). The preview reflects this pane's unsaved buffer and follows it when a new markdown file is opened in it.

**Tab**: A named pane layout within a Workspace. Each tab has its own root `PaneNode`.
_Avoid_: view, screen

**PTY**: A pseudo-terminal process bound to a Pane. Identified by a `ptyId` string. Spawned on first render; IDs from previous sessions are cleared on load.
_Avoid_: terminal process, shell

**Agent**: A detected AI coding CLI tool (Claude Code, Copilot, Gemini CLI, Aider, Codex, OpenCode) that can be launched inside a Pane. Detected by scanning `$PATH`; not spawned until the user requests one.

**Agent hook**: A lifecycle event an Agent emits — prompt submitted, permission requested, turn finished, turn failed — that Abundio observes (via the Agent's own hook system) to drive the status indicator. Abundio only observes; it never alters the Agent's behaviour.
_Avoid_: callback, event listener

**Waiting**: An Agent state in which the Agent has emitted a permission- or input-request hook and the user has not yet responded in its terminal. Distinct from a finished turn ("ready") — the Agent is stalled mid-turn, not done.
_Avoid_: blocked, idle, stuck

**Working**: A PTY state in which work is in progress — an **Agent** mid-turn (between turn-start and turn-end hooks, not blocked on a permission/input request) or a **shell-mode PTY** between the shell-integration `command_start` and `command_end` markers. Distinct from **Waiting** (agent-only — blocked on the user) and from a finished turn/command. The status indicator differs by mode: agent-Working is the amber broken double-ring spinner (a warm "attention, watch progress" colour), shell-Working is the cyan breathing triple-chevron `>>>` (a cool "neutral throughput" colour — you started the command, no alarm needed).
_Avoid_: active (collides with **Active workspace**), busy, running

**Ready**: An **Agent** state in which the Agent finished its turn cleanly and the user has not yet acknowledged it (by focusing or typing in its pane). Shown as the purple status indicator. Distinct from **Idle** — Ready is a notification, Idle is the rested state after acknowledgement. **Shell-mode PTYs do not have a Ready state**: a clean command exit transitions straight to **Idle** — for a shell, the output that just rendered is itself the "you have something to look at" signal, and a separate notification state would be redundant. Only the **Error** state is surfaced for shells.
_Avoid_: finished, done, complete

**Idle**: A PTY's resting state — no work in progress, and the last finished turn or command (if any) has been acknowledged by the user. Also the default state for a freshly initialised PTY. Shown as the green status indicator.
_Avoid_: inactive, asleep

**Error**: A PTY state in which the most recent work failed — an **Agent** emitted an error hook (or its turn exited non-zero in agent mode), or a **shell-mode PTY**'s last command exited with a non-zero code that isn't a user-stop (130/143). Shown as the red status indicator. Cleared by user focus/click.
_Avoid_: failed, broken, crashed

**Status indicator**: The coloured dot Abundio shows for a Pane — and aggregated up to its Tab and Workspace — reflecting its PTY's current state. The state set differs by **PTY mode**: an **agent-mode PTY** can be Idle / Working / Waiting / Ready / Error; a **shell-mode PTY** can only be Idle / Working / Error (no Ready, no Waiting). Aggregation is also asymmetric: an agent-mode PTY propagates every state to its Tab and Workspace; a shell-mode PTY propagates only Error and otherwise contributes as Idle. So a tab whose only non-idle pane is a shell running a command reads green at the Tab level; a shell whose command errored turns its tab red. Working is shown in **different colours by mode** — amber spinner for an Agent (warm, attention-worthy), cyan breathing chevron `>>>` for a shell (cool, neutral throughput).

**Overview bar**: A horizontal strip across the top of the app window, between the **Titlebar** and the per-workspace tab row, showing glanceable global counts: **Opened workspaces** (out of total), each of the five **Agent** states (Idle, Working, Waiting, Ready, Error) aggregated across all opened workspaces, and the user's pending GitHub PR counts (review-requested and own open PRs, both account-wide). Always visible; read-only. The only piece of global chrome that lives between the Titlebar and the workspace stack.
_Avoid_: dashboard (implies interactivity), metrics bar, status bar (already taken — bottom of window), header

**Shell-mode PTY**: A PTY that Abundio has not currently detected as running an Agent — a plain shell. Its counterpart, an **agent-mode PTY**, has its status indicator driven by Agent hooks. A single PTY flips between the two as Agents are launched in it and exit.
_Avoid_: shell pane, terminal mode (a Pane has no mode — its PTY does)

## Relationships

- Every **Workspace** belongs to exactly one **Profile**; the Workspace ↔ Profile assignment is set at creation and not editable afterwards.
- Each **Profile-bound Window** shows exactly one **Profile**, and each Profile is shown in at most one Window. Opening a new Window requires picking a Profile that is not already shown elsewhere (or creating a new "Untitled" Profile inline from the File menu).
- **Auxiliary windows** (e.g. the **Settings window**) do not own a Profile, are not persisted in `windows.json`, and do not count toward the "last window closing quits the app" rule. Closing every Profile-bound window quits the app even when the Settings window is still open.
- The sidebar of a Window shows only Workspaces in *that Window's* **Active profile**.
- The set of **Opened workspaces** is always a subset of the Window's **Active profile**'s Workspaces — switching Profile *within a Window* closes every Opened workspace in that Window's previous Active profile.
- At least one **Profile** must always exist. Deleting the **Active profile** auto-switches the Window to the first remaining Profile in position order that is not already open in another Window. A Profile cannot be deleted while it is open in another Window; the active Profile cannot be deleted if no unowned profile is available to auto-switch into. Deleting any Profile cascade-deletes its Workspaces.
- The **Active workspace** is always also an **Opened workspace**.
- A Workspace shown in the sidebar may be neither Active nor Opened — it has not been activated this session.
- **Closing** a Workspace removes it from Opened; deleting also removes it from the sidebar.
- Each **Tab** belongs to exactly one **Workspace**.
- Each **Pane** belongs to exactly one **Tab**. A terminal pane holds at most one **PTY**; a file pane holds at most one open file; a preview pane holds neither — it references a **source pane**.
- A **preview pane** and its **source pane** always live in the same **Tab**.
- Abundio derives an **Agent**'s status by observing its **Agent hooks**; a permission-request hook puts the Agent into the **Waiting** state, which clears when the user types into that **Pane**'s terminal.
- Abundio derives a **shell-mode PTY**'s status from shell-integration OSC markers (`command_start` / `command_end`) emitted by Abundio's startup hooks; **Working** and **Error** for shells are detected this way (a clean exit returns to **Idle**, with no Ready hop). Without working shell integration the PTY degrades silently to permanent **Idle** (no false signal).

## Flagged ambiguities

- "Window" has two meanings in Abundio code and conversation, and they are unrelated: the **Window** entity (OS-level application window — a Tauri `WebviewWindow`) is canonical; the historical use of "window" to mean a **Pane** is forbidden. When discussing Panes, use "pane" or "split"; when discussing Windows, capitalise to disambiguate where ambiguity would arise.
- "Profile" in Abundio refers exclusively to the top-level grouping entity. Despite borrowing the word from VS Code / browser conventions (where it bundles identity + settings), Abundio's Profile currently only groups Workspaces — appearance, agents and GitHub identity remain global. The term was kept against the narrower fit of "Space" or "Group" so that the scope may widen later without renaming.
- "active workspaces" (plural) does not exist — **Active workspace** is a singleton. Colloquial use of the plural is resolved to **Opened workspaces** (the set of workspaces activated this session and still open). The **Overview bar** uses "Opened" as its label for this reason.
- "background loaded workspace" was used to mean both "every sidebar workspace" and "opened-but-not-active workspace" — resolved to the latter (an Opened workspace that is not Active).
- "panel" is used colloquially to mean both a **Pane** and the git-changes side panel — in code, the git-changes side panel is always referred to as "git panel" or "git changes panel", never "pane".
- "shell mode" / "terminal mode" were both used for a PTY not running an Agent — resolved to **shell-mode PTY**; the mode belongs to the PTY, not the Pane.
- The amber state is canonically **Working** in this doc — applying to both agent-mode and shell-mode PTYs — but `PtyActivityState` in code still uses the string `"active"`. Renaming the code value to `"working"` would remove the collision with **Active workspace** and align with the broadened glossary; deferred as a follow-up.
