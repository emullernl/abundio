# Peek explorer

Branch: `peek-explorer`. Terms: **Peek explorer**, **Peek**, **Orchestrator tab**, **Agent cycle** in `GLOSSARY.md`.

## Goal

In the Orchestrator view, a peeked Agent comes with its Workspace's file tree. Clicking a file opens it as an Orchestrator tab, and the file sits beside the Peek instead of covering it. This applies to every file tab, including those opened by `abundio file open` and Cmd+P.

## Decisions (from the grilling session, 2026-11-17)

- The tree sits in a narrow strip on the left edge of the Peek column, between the top area and the terminal. You can resize it and collapse it.
- It is the Explorer's own tree (`FileTree`), for the peeked pane's Workspace. It shares the Explorer tab's expanded folders, which works for free because `explorerStore.expandedDirs` / `dirContents` are keyed by absolute path.
- It is read-only. Its menu offers only Open, Reveal and Copy path: no New, Rename or Delete.
- Clicking a file runs `openOrchestratorFile({ kind: "file", path }, { focus: true })`.
- While there is a Peek, the selected file tab takes the graph's place and the Peek stays on the right. With no Peek, a file tab uses the full width, as it does now.
- On a file tab, the Agent cycle no longer brings the graph back. Only the Peek moves.
- Orchestrator helpers get a tree too: the Orchestrator folder.
- Whether the tree is shown, and its width, are kept per Window and persisted (`windowUiStore`).

## Commits

1. **File tabs leave room for the Peek.**
   - `OrchestratorViewBody` measures the Peek column's width with a `ResizeObserver` and writes `peekWidth` to `orchestratorStore` (0 with no Peek), the same way `panesTop` is shared.
   - `OrchestratorFileTabs` sets `right: peekWidth` on its overlay.
   - `cycleOrchestrator` drops its `selectOrchestratorTab(null)`.
   - Tests: the orchestratorCycle tests no longer expect the graph to be reselected.
2. **A read-only `FileTree`.** Add the props `readOnly` and `onOpenFile(path)`.
   - In read-only mode the menu is: Open, Reveal, Copy path (files); Reveal, Copy path (folders); Reveal Folder (empty area). No inline create or rename rows.
   - Cmd/Ctrl+click still opens a File window.
   - Pull the menu-building out into a pure `lib/fileTreeMenu.ts` so it can be tested.
3. **The Peek explorer.**
   - `components/Orchestrator/PeekExplorer.tsx` holds the strip, a drag handle and a `FileTree` for the Workspace that `findPaneLocation(peekPaneId)` finds.
   - A toggle button (`FolderTree` icon) in `PeekHeader`.
   - `windowUiStore` gains `peekExplorerOpen` (default true) and `peekExplorerWidth` (default 220, clamped 140–480 by the pure helper `clampPeekExplorerWidth` in `orchestratorLayout.ts`). Both are persisted.
   - The column keeps a minimum width for the terminal.
   - Tests: the clamp, and store persistence.
4. **Docs.** Update the CLAUDE.md component list. Add a note to ADR-0057 / ADR-0058 that a file tab no longer hides the Peek.

## Not in scope

- A tree for the Orchestrator itself when nothing is peeked (Cmd+P covers it).
- Editing actions (create, rename, delete) in the Peek explorer.
