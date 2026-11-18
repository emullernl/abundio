# Markdown File pane: rendered view

Bring the File window's markdown experience into Tabs: a markdown File pane opens rendered, with a switch to source. See `GLOSSARY.md` (**File pane**, **Preview pane**, **Settings ▸ Editor**) and ADR-0061.

## Decisions (from the design session)

| Topic | Decision |
|-------|----------|
| Views | One at a time, like a File window: **rendered** (read-only, shows the live buffer, unsaved edits included) or **source** (Monaco, editable). |
| Where | File panes in Workspace Tabs and file Orchestrator tabs. Diff and Commit diff panes are unchanged. |
| Which files | `isMarkdownFile`, the same rule as File windows. |
| Default | Rendered. The Settings ▸ Editor option that auto-opened a Preview pane becomes **Open markdown rendered** (on by default; off opens in source). A user who had turned auto-open off keeps it off. |
| Remembered | Per pane, across restarts. A pane saved before this change has no view on record and follows the setting. |
| Preview pane | Kept, but opened only on request: the pane menu's **Open Preview Beside** / **Close Preview**. Opening a file never adds one. Existing ones in saved layouts stay. |
| Cmd+Shift+M | Switches rendered / source on a markdown File pane (as in a File window). On a Preview pane it closes it, as today. |
| Rendered tools | Preview color mode, Print, Find (Cmd+F), Open in Separate Window (opens in the pane's current view). |
| Go to a line | Search result, terminal file link, Agent `file open --line`: the pane switches to source at that line. |
| Links | In a Tab: opens the file rendered in a new Tab, or goes to the Tab already showing it; Cmd/Ctrl+click opens a File window. In a File window: another File window (already so). In an Orchestrator tab: another Orchestrator tab. The current pane is never replaced. No Back / Forward. |
| `file open --preview` | Opens rendered whatever the setting. No Preview pane. Without it: follows the setting. `--line` wins and shows source. |

Rule settled during planning (not in the session): a markdown file with **merge conflicts** always shows source while it is conflicted, because the conflict toolbar and Merge view work on the editor. The switch is disabled with a tooltip saying why.

## Steps (ordered commits on one branch, `markdown-pane-rendered-view`)

Before running the app with step 5 in place, back up `abundio.db` (+ `-wal`, `-shm`): there are no down-migrations.

### 1. Model and pure helpers

- `lib/types.ts`: the `file` `PaneNode` gains `markdownView?: MarkdownView` (`"rendered" | "source"`, the type `lib/ipc.ts` already has for File windows).
- New `lib/markdownView.ts` (pure):
  - `effectiveMarkdownView({ stored, openRendered, isMarkdown, isUnmerged })` → the view to show.
  - `markdownLinkTarget(e, mac)` → `"tab" | "window"` (reuses `clickOpensFileWindow`'s modifier rule).
- `lib/paneTree.ts`: `setFileNodeView(tree, paneId, view)`.
- Tests for all three.

### 2. Setting and opening

- `settingsStore`: rename `markdownPreviewAutoOpen` → `markdownOpenRendered`, reading the old key once when the new one is absent. Same toggle row in `EditorSection`, new label and help text.
- `markdownPreview.ts`: `buildFilePaneLayout` never adds a Preview pane. It takes an optional `view` and writes it on the node (used by links and `--preview`). The auto-open suppression set goes (nothing auto-opens); `toggleMarkdownPreviewForPane` stays for Open Preview Beside.
- `explorerStore.openFile` / `openFileInSplit`: pass an optional `view` through. An existing Tab is focused and keeps its own view.
- Tests: no Preview pane on open; `view` lands on the node; settings migration.

### 3. Shared rendered surface

- Extract from `FileWindowApp.tsx`:
  - `components/FileViewer/MarkdownViewSwitch.tsx` — the Rendered / Source segment (from `FileWindowToolbar`).
  - `components/FileViewer/RenderedMarkdownView.tsx` — the scroll area, `MarkdownRendered`, `MarkdownFindBar`, colour mode attributes; exposes its element for Print. `MarkdownFindBar` moves to `FileViewer/`.
- `MarkdownRendered`'s `onLinkClick` also receives the click's modifiers.
- File window keeps working exactly as now (no behaviour change in this step).

### 4. File pane rendered view

- `FilePane.tsx`: compute the view with `effectiveMarkdownView`. Rendered shows `RenderedMarkdownView`; Monaco stays **mounted but hidden** so undo history and cursor survive a switch. A switch writes `markdownView` to the layout (`updateLayout`), or calls the `embedded` callback in an Orchestrator tab.
- `FilePaneTitleBar`: the switch, plus colour mode, Find, Print in rendered view.
- Pane menu: Show Source / Show Rendered, Open Preview Beside / Close Preview, Print (prints the pane's own rendering; from source it switches to rendered first).
- `App.tsx` `toggle-markdown-preview`: markdown File pane → switch view; Preview pane → close it.
- Cmd+F (`searchPaneId === paneId`) opens the find bar in rendered view.
- `pendingGotoLine` for this pane's file while rendered → switch to source; `CodeEditor` then consumes it.
- Links: plain click → `openFile(workspaceId, path, { view: "rendered" })`; Cmd/Ctrl+click → `openFileWindow`. The Preview pane's links follow the same rule (they now use the pane's Workspace, not the Active one).
- `fileWindowTargetForPane` / Open in Separate Window: the window opens in the pane's current view.
- Tests: view switching writes the layout; go-to-line flips to source; conflicted file stays source; link targets.

### 5. Orchestrator tabs (Rust + TS)

- Migration `024_orchestrator_tab_view.sql`: `ALTER TABLE orchestrator_tabs ADD COLUMN view TEXT CHECK (view IN ('rendered', 'source'));` then `UPDATE orchestrator_tabs SET view = 'rendered' WHERE preview = 1;`. The `preview` column stays, unused.
- `workspace_store.rs`: `OrchestratorTab` / `NewOrchestratorTab` carry `view: Option<String>` instead of `preview`; re-adding an existing tab with a view sets it. `set_orchestrator_tab_view(profile_id, id, view)`, validated.
- `orchestrator.rs`: command `orchestrator_tab_set_view`; register in `lib.rs`.
- TS: `ipc.ts` types and wrapper; `OrchestratorFileTabs` drops the side-by-side Preview, passes the view and its setter into `FilePane`'s `embedded`; links open Orchestrator tabs; demo `mockInvoke` handles the new command.
- Tests: Rust round-trip, migration of `preview = 1`, refusal of a bad view; TS tab body.

### 6. Agent control `--preview`

- `fileOpen.ts`: `--preview` → `view: "rendered"` for a Tab, an Orchestrator tab and a File window; `--line` → source.
- Rust help text (`agent_control.rs` FILE) and `src-tauri/skill/SKILL.md`: "--preview opens markdown rendered".
- Tests: `fileOpen` places; Rust usage text unchanged otherwise.

### 7. Docs

- `CLAUDE.md`: Settings ▸ Editor and FilePane notes; ADR-0001 gets a line pointing at ADR-0061.
- Check `GLOSSARY.md` still matches what shipped.

## Done when

`pnpm test`, `cargo test`, `pnpm check` and `tsc` pass, and in the running app: a `.md` from the explorer opens rendered in one pane; the switch, Cmd+Shift+M, Find, Print and colour mode work; a link opens a new Tab; a search hit lands in source; the view survives a restart; an Orchestrator tab does the same.
