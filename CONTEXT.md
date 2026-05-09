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

**Pane**: A single terminal slot within a Workspace tab. Panes form a recursive binary split tree (`PaneNode`).
_Avoid_: panel, window, split

**Tab**: A named pane layout within a Workspace. Each tab has its own root `PaneNode`.
_Avoid_: view, screen

**PTY**: A pseudo-terminal process bound to a Pane. Identified by a `ptyId` string. Spawned on first render; IDs from previous sessions are cleared on load.
_Avoid_: terminal process, shell

**Agent**: A detected AI coding CLI tool (Claude Code, Copilot, Gemini CLI, Aider, Codex, OpenCode) that can be launched inside a Pane. Detected by scanning `$PATH`; not spawned until the user requests one.

## Relationships

- The **Active workspace** is always also an **Opened workspace**.
- A Workspace shown in the sidebar may be neither Active nor Opened — it has not been activated this session.
- **Closing** a Workspace removes it from Opened; deleting also removes it from the sidebar.
- Each **Tab** belongs to exactly one **Workspace**.
- Each **Pane** belongs to exactly one **Tab** and holds at most one **PTY**.

## Flagged ambiguities

- "background loaded workspace" was used to mean both "every sidebar workspace" and "opened-but-not-active workspace" — resolved to the latter (an Opened workspace that is not Active).
- "panel" is used colloquially to mean both a **Pane** and the git-changes side panel — in code, the git-changes side panel is always referred to as "git panel" or "git changes panel", never "pane".
