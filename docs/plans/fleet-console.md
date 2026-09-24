# Plan: Fleet Console

## Context

The user wants one view that shows every running Agent across the Window's Opened workspaces as a grid of live terminals, with each tile clearly naming its Workspace and status. From a tile you can jump to the Agent's place in the normal view, and from the grid you can start a new Agent, optionally in a new worktree. The Overview bar stays visible.

Terms are in `CONTEXT.md`: **Workspace view**, **Fleet Console**, **Fleet tile**, **Focused tile**, **Switch to**, **New agent** (Fleet Console). The architectural decision is ADR-0040.

What exists today:

- **Terminals are pooled and portaled.** `TerminalPool` (`App.tsx:1019`) mounts one `TerminalInstance` per terminal pane of every Opened workspace, off-screen. Each `TerminalSlot` registers its inner `div` with `lib/portalRegistry.ts` (`TerminalSlot.tsx:249`), and `TerminalInstance` moves the xterm DOM into whatever target is registered (`TerminalInstance.tsx:189`). The registry holds **one** target per pane: a second `registerTarget` overwrites the first, and `unregisterTarget` deletes whatever is there.
- **Opened workspaces stay mounted** (ADR-0002): background ones are `visibility: hidden`, so their `TerminalSlot`s stay registered.
- **Statistics overlay** is the precedent for a surface over the workspace stack: `windowUiStore.statisticsOverlayOpen`, toggled from the Overview bar (`App.tsx:187`) and a `toggle-statistics-overlay` action (`App.tsx:836`).
- **Agent-mode** is `activities[ptyId].detectionMode === "agent"` in `ptyActivityStore`, the same signal the Action bar and Overview bar read.
- **`createTab(workspaceId, agent)`** (`workspaceStore.ts:767`) already launches an Agent in a new Tab, but it also sets that Workspace's active Tab and the Window's `focusedPaneId`.
- **Add worktree** lives inside `WorkspaceList` (dialog + progress modal, `WorkspaceList.tsx:426`), which is part of the Left sidebar. The console hides that sidebar.
- **Visibility for notifications** is `isPaneVisible` (`notificationRouter.ts:46`): "in the Active workspace's active Tab". Notification clicks switch Workspace/Tab/pane.

## Design decisions (resolved with the user)

- **Membership:** agent-mode PTYs only, in this Window's Opened workspaces. When an Agent exits, its tile leaves the grid. Other Windows' Agents are not shown (ADR-0007: a Window owns its Profile's PTYs).
- **Surface:** everything between the Overview bar and the Status bar, **both sidebars hidden**. Tab bar and Right sidebar hidden. Overview bar and Status bar stay.
- **Toggle:** `Cmd+Shift+A` / `Ctrl+Shift+A` (currently unbound), plus a button on the Overview bar next to Statistics. Console and Statistics overlay are **mutually exclusive**: opening one closes the other, and closing Statistics returns to the view it was opened from.
- **Tiles are live and interactive:** typing, the Action bar, prompt digits and Palette firing all work. The PTY is **resized to the tile** (ADR-0040), so each Agent reflows on entering and leaving the console.
- **Own focus:** the console has a **Focused tile**, separate from `focusedPaneId`. Nothing in the console changes the Active workspace, its active Tab or its Focused pane, except **Switch to**. Focusing a tile acknowledges Ready/Error exactly as focusing its pane does.
- **Tile title bar:** status icon, Agent icon, Workspace name, git branch, Tab name (dimmed), **Switch to** button (`↗`), and the `⋯` pane menu minus Split Right / Split Down. Close Pane stays and closes the real Pane, with the existing confirm.
- **Grid:** a preset of columns × **visible rows**, plus draggable column and row dividers. The row count sets how many rows fit on screen (the tile height), not how many exist. Extra Agents add rows of the same height and the grid scrolls vertically. No "add row" / "add column" buttons. Default preset: **Auto** (column count picked from the Agent count and the area's aspect ratio).
- **Order:** derived, never stored. Left-sidebar Workspace order (`flattenRowsToIds(buildWorkspaceRows(...))`), then Tab order, then depth-first pane order.
- **Empty cells** show the **New agent** tile. With no Agents at all, the grid shows one New agent tile and a line of text saying there are no running Agents.
- **Shortcuts in the console:** Pane cycle and Directional move walk the grid (reading order, and grid geometry). Tile-scoped actions (Find, Copy, Paste, prompt digits, Close Pane) act on the Focused tile. Split, new/close Tab, next/prev Tab, panel toggles, Workspace cycle and Add worktree do nothing.
- **Notifications:** while the console is on, every tile counts as on screen and the hidden Workspace view does not. Clicking an OS notification focuses the matching tile and scrolls it into view instead of leaving the console. If the pane is not a tile (a shell-mode Error), it leaves the console and behaves as today.
- **Status bar:** names the Focused tile's Workspace (name, folder, branch, Tab). With no Focused tile, it shows "Fleet Console".
- **New agent:** a dialog lists **every Workspace in the Active profile**, Opened ones first, then an Agent picker. The Agent starts in a **new Tab** of that Workspace, which does **not** become the active Tab. An unopened Workspace is opened in the background (added to Opened, not made Active). For a git Workspace, a *Create a new worktree* checkbox reveals the branch/folder fields and hands off to the existing Add worktree flow (from a Linked worktree it targets the set's Primary). The new worktree Workspace is also opened in the background, not activated. The new tile becomes the Focused tile.
- **Persistence:** grid preset and divider ratios are remembered **per Window** (`windowUiStore`, persisted). Console on/off is **not** persisted: every launch opens in the Workspace view.

## Commits (one branch)

1. **Portal registry holds a stack of targets.** `registerTarget(paneId, el)` pushes; `unregisterTarget(paneId, el)` removes that element only (the signature gains `el`); the top of the stack is the live target, and listeners are notified whenever the top changes. Update `TerminalSlot`'s cleanup. Tests: push/pop order, removing a non-top element does not notify, the last removal notifies `null`. This alone changes nothing visible, and it is what lets a tile borrow a pane and hand it back.

2. **Console state and toggle.** `windowUiStore`: `fleetConsoleOpen` (not in `partialize`), `toggleFleetConsole`, `setFleetConsoleOpen`, and mutual exclusion with `statisticsOverlayOpen` (opening either closes the other; remember `statisticsReturnTo: "workspace" | "fleet"`). `statisticsOverlayOpen` stays persisted as today; since the console is not, a launch can never open both. New action `toggle-fleet-console` (`Cmd+Shift+A` / `Ctrl+Shift+A`) in `keybindings.ts`, workspace-global so it works from Monaco. Command palette entry. Overview bar gets `fleetConsoleOpen` / `onToggleFleetConsole` props and a second right-aligned button beside Statistics. Tests: store transitions, OverviewBar button.

3. **Membership and order (pure).** `lib/fleetConsole.ts`: `fleetTiles(workspaces, rowOrderIds, openedIds, activities, panePtyMap)` returns `{ paneId, ptyId, workspaceId, tabId, tabName }[]` in derived order, agent-mode only. `autoColumns(count, width, height)`. `gridCells(tiles, columns, visibleRows)` returns the rows to render (tiles plus trailing New agent cells). Table tests: ordering across Worktree sets and folded sets, a shell-mode PTY excluded, an Agent exiting removes its tile, empty state.

4. **Fleet Console surface.** `components/FleetConsole/FleetConsole.tsx`, rendered in `App.tsx` in place of the Left sidebar, workspace stack and Right sidebar while open. The workspace stack stays **mounted** (layered hidden, as today), so its `TerminalSlot`s stay registered underneath; the tiles push on top of them. CSS grid with `grid-template-columns` from the column ratios, row height = area height / visible rows, vertical scroll. Toolbar row at the top: presets (Auto, 1–4 columns × 1–3 rows). Column and row dividers reuse `PaneResizer`'s drag logic; ratios persist to `windowUiStore.fleetGrid` on mouseup only (the existing resize convention). Tests: preset changes, persistence round-trip.

5. **Fleet tile.** `components/FleetConsole/FleetTile.tsx` wrapping `TerminalSlot` with a new `variant: "fleet"` prop. The fleet variant: registers its target through the stack from commit 1; hides Split Right / Split Down in the `⋯` menu; renders the fleet title bar (status icon, Agent icon, Workspace · branch, Tab name, `↗`); takes `isFocused` / `onFocus` from the console's `focusedTileId` rather than `workspaceStore.focusedPaneId`. Close Pane routes to the existing `closePaneNow` + confirm, which calls `teardownTerminal` (ADR-0020). Resize: the existing FitAddon/ResizeObserver path already resizes the PTY when the target's size changes; verify it fires on both borrow and hand-back, and that the hand-back fits to the pane's size, not the tile's. Tests: menu has no split items, focusing a tile does not change `focusedPaneId` or `activeTabByWorkspace`, focus acknowledges Ready.

6. **Switch to.** `switchToPane(paneId)`: close the console, `beginWorkspaceSwitch`, `setActiveTab`, `setFocusedPane`. Reuse the body of `handleNotificationClick`'s `pty` branch (extract it). Wired to the `↗` button and to double-click on the tile title bar. Test: store state after the call.

7. **Focused tile and shortcut routing.** `fleetConsoleStore` (or a slice of `windowUiStore`, not persisted): `focusedTileId`. `keybindings.ts`: when the console is open, `next-pane` / `prev-pane` cycle tiles in grid order, `navigate-*` pick the geometric neighbour in the grid (pure helper in `lib/fleetConsole.ts`, tested), and the layout/panel actions listed above return early. Actions that target "the focused pane" (`find`, `copy`, `paste`, `prompt-action-N`, `close-pane`, palette firing) resolve their target through one helper, `targetPaneId()`, which returns `focusedTileId` in the console and `focusedPaneId` otherwise. Tests: each action's target in both views; muted actions do nothing.

8. **View-aware visibility and notification clicks.** `isPaneVisible(paneId)`: in the console, true iff the pane is a current tile; otherwise unchanged. `handleNotificationClick`: in the console, if the pane is a tile, set `focusedTileId` and scroll it into view; otherwise fall through to Switch to. Status bar: in the console, derive its Workspace/Tab from `focusedTileId`, else show "Fleet Console". Tests for both helpers.

9. **New agent.** `createTab` gains an options argument `{ activate?: boolean }` (default `true`). With `activate: false` it appends the Tab and records the pending Agent but leaves `activeTabByWorkspace` and `focusedPaneId` alone. `components/FleetConsole/NewAgentDialog.tsx`: Workspace list (Opened first, then the rest, sidebar order), Agent list (reuses `LaunchPicker`'s option building), and for git Workspaces the *Create a new worktree* checkbox. Unopened Workspace: add to `openedWorkspaceIds` without making it Active (check that `TerminalPool`'s 2 s deferred load does not hold back the new PTY: the tile should appear promptly). On success, set `focusedTileId` to the new pane once it becomes agent-mode. Use `useEscapeKey` and `Select.tsx`, not a native `<select>`. Tests: `createTab` with `activate: false`, dialog ordering, worktree checkbox shown only for git Workspaces.

10. **Worktree from the console.** Lift the Add worktree dialog and progress modal out of `WorkspaceList` into an app-level host driven by `windowUiStore` (extend the existing `addWorktreeRequest` to carry an optional `{ agent, background: true }`), so it works while the Left sidebar is hidden. `createWorktreeWorkspace` gains a background option: open the new Workspace without activating it. Its Worktree setup commands and Agent run in its focal terminal as today. Tests: request round-trip; background creation leaves `activeWorkspaceId` unchanged.

Docs: `CLAUDE.md` shortcut table (`Cmd+Shift+A` / `Ctrl+Shift+A`) and component list (`components/FleetConsole/`).

## Things to verify in the running app

Unit tests will not catch these (see the runtime-verification memory):

- Borrowing and handing back a terminal leaves it at the right size in its pane, with no blank or duplicated xterm.
- Claude Code's redraw after a resize is acceptable in practice.
- The WebGL context budget (12 per Window, `terminalManager.ts`): tiles reuse existing contexts, so no new ones should be created. Confirm with many Agents.
- Typing into a tile of a Background workspace reaches the right PTY, and acknowledges Ready.
- An Agent exiting while its tile is focused: focus moves to the next tile, or to nothing.
- A New agent in an unopened Workspace appears as a tile without toggling the console.

## As built (deviations from the commits above)

- The commits were merged into fewer: surface, tiles, Switch to, New agent and the worktree hand-off landed together.
- **Commit 1** grew a priority: a stack alone was not enough, because a Workspace-view slot that remounts while the console is open would push itself above the tile. Tiles register at `FLEET_TILE_PRIORITY`. `promptActionRegistry` got the same stack, or a tile unmounting would unregister the slot's digit handlers.
- **Commit 10** did not lift the Add worktree dialog. Both sidebars are clipped to zero width instead of unmounted, and the dialog is `position: fixed`, so it still shows. `addWorktreeRequest` became `{ workspaceId, agentId?, background? }`, and `createWorktreeWorkspace` takes `{ background }`.
- `closePaneNow` now finds the pane's Tab by id rather than using the active Tab, since a tile can close a pane in any Workspace. It moves focus only when that Tab is the one on screen. `closeTab`'s last-tab path keeps focus when the Workspace is not Active.
- `toggleSearch` takes an optional pane id.
- `windowUiStore.pendingTile` holds focus on a just-started Agent's tile until its PTY reaches agent mode (up to 20 s).
