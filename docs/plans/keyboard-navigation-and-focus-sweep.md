# Plan: Keyboard navigation and the Focus sweep

## Context

The user wants to move between Workspaces, Tabs and Panes from the keyboard, and to see a short visual cue on a Pane when it becomes the Focused pane. They also want a shortcut for **Add worktree**.

What exists today:

- **Tabs:** `Cmd+Shift+]` / `[` cycle tabs (`App.tsx`, `next-tab` / `prev-tab`). The bindings match `e.key` `"]"`/`"["`, which Shift turns into `}`/`{` on most layouts, so they may never fire.
- **Panes:** `Cmd+Shift+Arrow` is labelled directional but is a disguised tree-order cycle over **terminal panes only** (`useSplitPane.navigatePane`): →/↓ = next, ←/↑ = previous. File, preview and merge side panes are unreachable.
- **Workspaces:** no shortcut.
- **Focus cue:** unfocused panes dim to 0.75 opacity (`TerminalSlot.tsx`). No transient cue.

New terms are in `CONTEXT.md`: **Focused pane**, **Pane cycle**, **Directional move**, **Workspace cycle**, **Focus sweep**, plus the Add worktree shortcut rule.

## Design decisions (resolved with the user)

| Action | macOS | Windows/Linux |
|---|---|---|
| Workspace cycle next / prev | `Cmd+Option+↓` / `↑` | `Ctrl+Shift+PageDown` / `PageUp` |
| Tab cycle next / prev (existing, now by `code`) | `Cmd+Shift+]` / `[` | `Ctrl+Shift+]` / `[` |
| Pane cycle next / prev | `Cmd+Option+]` / `[` | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Directional move (rewritten) | `Cmd+Shift+Arrow` | `Ctrl+Shift+Arrow` |
| Add worktree | `Cmd+Shift+B` | `Ctrl+Shift+B` |

- No `Ctrl+Alt` on Windows/Linux: it is AltGr on European layouts. Bracket and arrow bindings match `KeyboardEvent.code`.
- **Workspace cycle** visits only **Opened workspaces**, in Left sidebar order (`flattenRowsToIds(buildWorkspaceRows(...))`), wrapping. It never opens a Workspace. Landing on a hidden Linked worktree unfolds its set (the existing invariant in `WorkspaceList`). It scrolls the sidebar row into view.
- **Pane cycle** visits every Pane type in depth-first tree order, wrapping.
- **Directional move** uses geometry computed from the split tree's ratios (pure, no DOM). It picks the neighbour on that side that lies across from the Focused pane's centre line. It does not wrap.
- **Focus sweep:** an accent-coloured arc that travels once clockwise around the pane border (~450 ms) and fades. It fires on every change of Focused pane to a different pane, including the first focus after a Window opens, but only when the Tab has more than one Pane (both revised after trying it). It starts only once frames are smooth again, because a workspace switch stalls the main thread for ~250 ms and would otherwise freeze the SVG animation mid-lap. A new focus cuts the previous sweep short. Under `prefers-reduced-motion` it is a static fading border. Drawn in a `pointer-events: none` overlay above the pane. Global setting `focusSweep`, default on, in Settings ▸ Theme.
- **Add worktree shortcut** targets the Active workspace's repository: a main worktree opens the dialog for itself, a Linked worktree for its set's Primary, and a non-git Workspace does nothing. There is no toast system, so there is no feedback in that case.
- Command palette entries for the new actions. The palette has no shortcut column, so none is shown.
- No ADR: every choice is cheap to reverse.

## Commits (one branch)

1. **Bracket bindings match by `code`.** `next-tab`/`prev-tab` → `BracketRight`/`BracketLeft`.
2. **Directional move.** `paneTree.ts`: `paneRects(tree)` (unit-square rects from ratios) + `neighbourInDirection(tree, fromId, dir)`. `navigatePane` uses it. Table tests: L-shapes, 3-way column, edges, all pane types.
3. **Pane cycle.** `paneTree.ts`: `cyclePane(tree, fromId, step)` over `collectPaneIds`. New actions `next-pane` / `prev-pane`, workspace-global.
4. **Workspace cycle.** `lib/workspaceCycle.ts`: `cycleOpenedWorkspace(orderIds, opened, activeId, step)`. New actions `next-workspace` / `prev-workspace`; the handler builds the sidebar order from `workspaceStore` + `workspaceGitStore` and calls `beginWorkspaceSwitch`. The active sidebar row scrolls into view.
5. **Focus sweep.** `lib/focusSweep.ts`: pure `shouldSweep` rule + a small zustand store fed by a `useWorkspaceStore.subscribe` on `focusedPaneId`. `FocusSweep` overlay component wrapped around every leaf in `SplitContainer`. CSS keyframes in `globals.css`. Setting `focusSweep` in `settingsStore` (persist version bump to 11), with a toggle in `ThemeSection`.
6. **Add worktree shortcut.** `worktreeGrouping.ts`: `addWorktreeTargetId(workspaces, facts, activeId)`. `windowUiStore.addWorktreeRequest` read by `WorkspaceList`, which opens its existing dialog. Action `add-worktree` + palette entry.

Docs: the `CLAUDE.md` shortcut table.
