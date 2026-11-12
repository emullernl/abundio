# Agents list in the Left sidebar

List every running Agent under the Workspace list, with its status, its Agent, its Workspace and Tab, and the title it gives its terminal. Clicking a row goes to that pane. See `GLOSSARY.md` (**Agents list**, **Agent row**, **Switch to**).

## Why

To find an Agent that needs you today, you scan the Workspace rows' status icons, open the Workspace, then find the pane. The Fleet Console shows every Agent, but it takes over the whole Window. The Agents list gives the same overview in the sidebar while you keep working in the Workspace view.

## Decisions (from the design session)

| Topic | Decision |
|-------|----------|
| Which Agents | Every agent-mode PTY in this Window's Opened workspaces. The same set as the Fleet Console. |
| Order | The Fleet Console's derived order: sidebar Workspace order, then Tab, then pane. Rows never reorder when a status changes. |
| Placement | Below the Workspace list, under a draggable divider. Collapses to its header. |
| Persistence | Collapsed state per Window (`windowUiStore`). Height global (`settingsStore`), not broadcast, like `rightSidebarCommitsShare`. |
| Header | "Agents" and the count, e.g. `AGENTS · 4`, plus a collapse chevron. |
| Row, line 1 | Status icon, Agent icon, the Agent's terminal title. Falls back to the Agent's name when it has set no title. |
| Row, line 2 (dim) | Workspace name · Tab name. |
| Tooltip | Agent name, full title, Workspace, Tab. |
| Click | **Switch to** (`switchToPane`): Workspace active, Tab active, pane focused. A hidden member of a Folded set unfolds through the existing "never hide the Active workspace" rule. |
| Selected row | The Focused pane of the Active workspace, drawn like the active Workspace row (`--row-active-bg` + left border). |
| Right-click menu | None. |
| No Agents | Header stays, body says "No agents running". |
| Folded set | Its Agents are still listed. |
| Collapsed sidebar (44px strip) | List not shown. |
| Fleet Console open | Nothing to do: the Console already hides both sidebars. |

## Steps (ordered commits on `feat/sidebar-agents-list`)

### 1. Share the Fleet tile list and the pane status hook

- Move `useFleetTiles` out of `components/FleetConsole/FleetConsole.tsx` into `hooks/useAgentPanes.ts`. It takes `{ includePending: boolean }`:
  - The Fleet Console passes `true` (keeps `alsoShow` = `pendingTiles`, so a just-started Agent gets its tile before it is in agent mode).
  - The Agents list passes `false`: a pending pane is not running an Agent yet.
- Move `usePtyDotStatus` out of `TerminalTitleBar.tsx` into `hooks/usePaneStatus.ts` (exported), so a row and the title bar read status the same way.
- Extract the title rule from `TerminalTitleBar` into a pure `lib/agentRowTitle.ts`: `agentRowTitle({ agentName, xtermTitle })` → the terminal title, or the Agent's name when the title is empty. Keep the title bar's own `Agent : title` format as it is.
- No behaviour change. Existing Fleet Console tests must stay green.

Tests: `src/lib/__tests__/agentRowTitle.test.ts` (title present, empty, whitespace only). `fleetTiles` tests already cover order and membership; add one case for `alsoShow` being absent.

### 2. Layout math for the split

- `lib/leftSidebarLayout.ts`, pure, modelled on `lib/rightSidebarLayout.ts`:
  - `leftSidebarShares({ agentsShare, agentsCollapsed })` → `{ workspaces, agents }` flex shares. Collapsed → agents takes only its header (`0 0 auto`).
  - `agentsShareFromDrag(y, containerHeight)` clamped so neither side drops below a minimum (e.g. 0.15 / 0.85).
- `settingsStore`: `leftSidebarAgentsShare` (default `0.3`), add to `PERSISTED_KEYS` and to `NOT_BROADCAST` (a drag-derived size, like the other sidebar sizes). Validate on rehydrate like `rightSidebarCommitsShare`.
- `windowUiStore`: `agentsListCollapsed` (default `false`) + `toggleAgentsListCollapsed`, included in its persisted slice.

Tests: `src/lib/__tests__/leftSidebarLayout.test.ts`; settings rehydrate falls back to the default for a non-number; `NOT_BROADCAST` contains the new key.

### 3. `AgentsList` and `AgentRow` components

- `components/Sidebar/AgentsList.tsx`: header (`Bot` icon, `AGENTS · N`, chevron), then a scrolling body of `AgentRow`s from `useAgentPanes({ includePending: false })`, or the "No agents running" line.
- `components/Sidebar/AgentRow.tsx`, one per pane:
  - `usePaneStatus(paneId)` → `AgentStatusIcon`.
  - Agent id from `usePtyActivityStore.detectedAgentIds[ptyId]` → `getAgentIconComponent` and the name from `settingsStore.agents`.
  - Title from `usePtyActivityStore.titles[paneId]` through `agentRowTitle`.
  - Workspace name from `workspaceStore.workspaces`; Tab name from the tile.
  - Selected when `activeWorkspaceId === tile.workspaceId && focusedPaneId === tile.paneId`.
  - `onClick` → `switchToPane(paneId)`. A `<button>` so it is reachable by keyboard; Enter/Space work for free.
  - Selects narrow slices only (one pane's title, one ptyId's status), so a chatty Agent's title changes re-render its own row, not the list.
- Styling per CLAUDE.md: padding inline, hover colours in classes (an inline `backgroundColor` would kill `hover:`), both lines `truncate`.

Tests (`src/components/Sidebar/__tests__/AgentsList.test.tsx`, jsdom, stores via `setState`):
- Lists only agent-mode panes of Opened workspaces, in derived order.
- A pending Fleet tile is not listed.
- Title falls back to the Agent name.
- Selected row follows Active workspace + Focused pane; a focused pane in a Background workspace is not selected.
- Click calls `switchToPane` with the pane id.
- Empty state text and the header count.
- An Agent in a hidden member of a Folded set is listed.

### 4. Put it in the sidebar

- `Sidebar.tsx` (expanded variant only): replace the single `flex-1` Workspace list container with the Workspace list (`flex: shares.workspaces`), a `SectionDivider` (hidden when collapsed), and `AgentsList` (`flex: shares.agents`, or `0 0 auto` when collapsed). Live drag value in local state, persisted on mouseup, as in `RightSidebar.tsx`.
- Reuse `components/RightSidebar/SectionDivider.tsx` as is (move it to a shared place only if the import looks wrong).
- `CollapsedStrip` unchanged.

Tests: `Sidebar` renders `AgentsList` when expanded and not in the collapsed strip; divider absent while collapsed.

### 5. Docs and demo

- `CLAUDE.md`: list `AgentsList` / `AgentRow` under `components/Sidebar/`, `hooks/useAgentPanes.ts`, `hooks/usePaneStatus.ts`, `lib/agentRowTitle.ts`, `lib/leftSidebarLayout.ts`.
- Check `pnpm demo:web`: the demo's agent transcripts should fill the list. Fix fixtures only if the list comes up empty there.
- `GLOSSARY.md` is already updated (design session).

## Verify in the real app

Unit tests are not enough here (status and agent detection are runtime behaviour). With `pnpm tauri dev`:

1. Start Claude Code in two Workspaces and a shell in a third. Two rows, in sidebar order; the shell is not listed.
2. Submit a prompt: the row's spinner matches the pane's. Claude's own title shows on line 1.
3. Quit one Agent (`/exit`): its row goes away. The pane stays as a shell.
4. Click a row in a Background workspace: that Workspace, Tab and pane come up, and the row is selected.
5. Fold a Worktree set holding an Agent: the row stays; clicking it unfolds the set.
6. Drag the divider, collapse the list, restart: the height comes back for every Window; the collapsed state per Window.
7. Collapse the sidebar to the strip: no list. Open the Fleet Console: both sidebars gone as before.
8. Close every Agent: "No agents running", the Workspace list does not jump.

## Not in this change

- Right-click menu on rows (Close pane, Restart).
- Agents from other Windows, or from Dormant workspaces.
- An attention count in the header.
- Showing the list in the collapsed icon strip.
