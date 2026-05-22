# Abundio

GPU-accelerated terminal multiplexer. The user organizes work into Workspaces; each Workspace runs its own pane layout and PTY processes.

## Language

**Workspace**: A folder-bound container with its own pane layout, tabs, and PTY processes.
_Avoid_: project, folder

**Active workspace**: The single Workspace currently selected and visible to the user. Singleton state (`useWorkspaceStore.activeWorkspaceId`).
_Avoid_: selected workspace, current workspace, focused workspace

**Opened workspace**: A Workspace the user has activated at least once this session and has not closed. Tracked by `usePtyActivityStore.openedWorkspaceIds`. PTY processes and file watchers stay alive for these even when not active.
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

**Status indicator**: The coloured dot Abundio shows for a Pane — and aggregated up to its Tab and Workspace — reflecting its PTY's current state.

**Shell-mode PTY**: A PTY that Abundio has not currently detected as running an Agent — a plain shell. Its counterpart, an **agent-mode PTY**, has its status indicator driven by Agent hooks. A single PTY flips between the two as Agents are launched in it and exit.
_Avoid_: shell pane, terminal mode (a Pane has no mode — its PTY does)

## Relationships

- The **Active workspace** is always also an **Opened workspace**.
- A Workspace shown in the sidebar may be neither Active nor Opened — it has not been activated this session.
- **Closing** a Workspace removes it from Opened; deleting also removes it from the sidebar.
- Each **Tab** belongs to exactly one **Workspace**.
- Each **Pane** belongs to exactly one **Tab**. A terminal pane holds at most one **PTY**; a file pane holds at most one open file; a preview pane holds neither — it references a **source pane**.
- A **preview pane** and its **source pane** always live in the same **Tab**.
- Abundio derives an **Agent**'s status by observing its **Agent hooks**; a permission-request hook puts the Agent into the **Waiting** state, which clears when the user types into that **Pane**'s terminal.

## Flagged ambiguities

- "background loaded workspace" was used to mean both "every sidebar workspace" and "opened-but-not-active workspace" — resolved to the latter (an Opened workspace that is not Active).
- "panel" is used colloquially to mean both a **Pane** and the git-changes side panel — in code, the git-changes side panel is always referred to as "git panel" or "git changes panel", never "pane".
- "shell mode" / "terminal mode" were both used for a PTY not running an Agent — resolved to **shell-mode PTY**; the mode belongs to the PTY, not the Pane.
