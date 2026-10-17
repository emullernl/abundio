# Markdown window

## The ask

> "I would like to be able to open a markdown file from the explorer tree in a new window (in
> wysiwyg view), with a toggle to see its source so I can edit it (using Monaco editor). It
> should also remember these opened windows, and reopen them when the workspace reopens."

## Decisions

These were settled in a grilling session. The terms are in `GLOSSARY.md` (**Window**, **Markdown window**) and the shape is recorded in ADR-0046.

1. **Window kind.** A real OS Window of a new, third kind: a **Workspace-bound window**. It is not Profile-bound and not Auxiliary. It is never stored in `windows.json` and never keeps the app running.
2. **Views.** It shows one view at a time, with a toggle between them:
   - **Rendered**: read-only, the same renderer as the Preview pane.
   - **Source**: editable, in Monaco.

   There is no side-by-side mode.
3. **First view.** A new window opens in the rendered view. A reopened window comes back in the view it was last in.
4. **Rendered extras.** These match the Preview pane:
   - Mermaid diagrams
   - the **Preview color mode** toggle
   - Print

   It also gets **Find** (Cmd/Ctrl+F) over the rendered text. In the source view, Find is Monaco's own.
5. **One window per file.** Opening a file that already has a Markdown window brings that window to the front.
6. **Same file in a File pane.** Each side keeps its own buffer. A save on one side reaches the other as an external change: a clean side reloads, and a side with unsaved edits shows the conflict banner.
7. **Lifetime.** The window belongs to one Workspace and lives only while that Workspace is Opened.
   - It is closed and **remembered** when:
     - the Workspace closes
     - the owning Window closes
     - the owning Window switches Profile
     - the app quits
   - It is reopened when the Workspace is next opened, including the first time it is opened after an app restart.
   - A window you close yourself is **forgotten**.
8. **Missing file on reopen.** If a remembered file no longer exists, the window is not opened and its record is dropped. No message is shown.
9. **Unsaved edits.** Closing a window that has unsaved edits asks Save / Discard / Cancel. The owning Window's close check, the Workspace close and the app quit all count these edits too.
10. **Ways to open it.**
    - **Open in Markdown Window** in the explorer's right-click menu
    - **Cmd+click** (macOS) or **Ctrl+click** (Windows/Linux) on a markdown file in the explorer
    - the File pane and Preview pane title-bar menus
    - a command-palette action that acts on the focused markdown pane. It is rebindable and has no default chord.
11. **Links in the rendered view.**
    - A link to a markdown file inside the Workspace opens or focuses that file's Markdown window.
    - `http(s)` and `mailto` links open in the system browser.
    - `#fragment` links scroll within the document.
    - Any other link does nothing.
12. **Storage.** One SQLite row per remembered window: `(workspace_id, file_path)`, a stable label, and the last view.

## Implementation (one branch, ordered commits)

> Back up `abundio.db` (and its `-wal` and `-shm` files) before running the new migration
> locally. There are no down-migrations.

### 1. Migration + store

`src-tauri/migrations/016_add_markdown_windows.sql`

```sql
CREATE TABLE markdown_windows (
    workspace_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    file_path    TEXT NOT NULL,
    label        TEXT NOT NULL UNIQUE,   -- md-<uuid>, stable across reopen
    view         TEXT NOT NULL DEFAULT 'rendered', -- 'rendered' | 'source'
    PRIMARY KEY (workspace_id, file_path)
);
```

`src-tauri/src/markdown_windows.rs`: `MarkdownWindowStore`, with CRUD for these rows:
- `upsert` returns the existing label, or a new one.
- `set_view`
- `delete_by_label`
- `list_for_workspace`
- `find_by_label`

Unit tests use an in-memory DB.

### 2. The window kind in Rust

`window_management.rs`:
- `MARKDOWN_WINDOW_PREFIX = "md-"` and `is_markdown_window_label`.
- `is_profile_window_label` returns false for `md-*`. Add a test, and check every caller listed in the `grep` (quit rule, `windows.json`, `pick_one_profile_window`, `app_metrics`, `search`, `commands.rs:250/282`).
- `open_or_focus_markdown_window(app, workspace_id, file_path)`:
  - Upsert the row.
  - If a window with that label exists, focus it.
  - Otherwise build `index.html?markdown` with the stored label. Use an overlay titlebar on macOS. The title is `<file name> — <workspace name>`.

`capabilities/default.json`: add `"md-*"`.

`lib.rs`, in the `on_window_event` handler:
- A Markdown window's `Destroyed` does none of the Profile bookkeeping, but `OwnerMap` still releases the window's file watch.
- A Profile window's `Destroyed` closes the Markdown windows of its Profile's Workspaces, **remembering** them. This is the backstop, because React cleanup never runs when a webview is destroyed.

**Why a window closed** is tracked in a Rust set of labels closing "on the owner's behalf" (`ClosingForOwner`). A Markdown window's own close handler asks Rust `md_window_close_cause(label)`:
- If the label is in the set, the row is kept.
- If not, the close is yours, and the row is deleted.

During quit, `QuittingFlag` counts as "on the owner's behalf".

IPC commands, all returning `Result<_, AbundioError>`:
- `md_window_open(workspace_id, file_path)`: validates that the path is inside the Workspace folder and is markdown.
- `md_window_info()`: the calling window's `{workspace_id, file_path, view}`, read by label. It is never taken from the URL.
- `md_window_set_view(view)`
- `md_window_set_dirty(dirty)`: kept in memory, per label.
- `md_windows_dirty(workspace_ids)`: file names of the windows with unsaved edits.
- `md_windows_close(workspace_ids)`: an owner-driven close that remembers the windows.
- `md_windows_restore(workspace_id)`: for each row, skip and delete it if the file is gone; otherwise open it unless it is already open.
- `md_window_forget()`: the calling window's row.

### 3. Shared rendered view

Pull the rendering out of `PreviewPane.tsx` into `components/FileViewer/MarkdownRendered.tsx`. It takes `content`, `filePath`, `onLinkClick` and a ref to the content element. It keeps the following:
- the debounce and the memoised parse
- the sanitize schema
- Mermaid code blocks
- inlined local images
- the colour mode

`PreviewPane` becomes a thin wrapper that reads `explorerStore`. Add an `a` component that sends every link click to `onLinkClick`. The Preview pane passes a handler that keeps today's behaviour. The pure link classifier lives in `lib/markdownLinks.ts` (workspace markdown / external / fragment / ignore) and gets tests.

### 4. `MarkdownWindowApp` root

`main.tsx`: when `currentWindowLabel()` starts with `md-`, render `<MarkdownWindowApp/>`. It skips the notification router and the mic probe. `setupCrossWindowSync()` already runs in every window, so theme and font changes arrive.

`src/MarkdownWindowApp.tsx`:
- **Loading and saving.** Load with `md_window_info` and then `fsApi.readFile`. It keeps its own buffer with an `isDirty` flag, and reports changes to that flag with `md_window_set_dirty`. It saves with `fsApi.writeFile`.
- **Title strip.** A `Titlebar` strip showing the file name, and a **Rendered / Source** toggle that persists through `md_window_set_view`.
- **Toolbar.** In the rendered view: the color-mode toggle, Print, and Find.
- **Source view.** Reuse `CodeEditor` with the shared Monaco config (`monacoShared`) and keymap Overrides (`applyMonacoOverrides`).
- **External changes.** Watch the file's folder with `fs_watch_start`. A clean buffer reloads; a dirty one shows `FileChangeBanner`. If the file is deleted, show the existing deleted-on-disk banner.
- **Keys.** Through the keybindings registry: Save, Find, Print, font zoom, and a new action `toggle-markdown-window-view` (Cmd/Ctrl+Shift+M by default, to match "Toggle markdown preview").
- **Closing.** `onCloseRequested`:
  - Unsaved edits and you closed it yourself: show `SaveConfirmDialog`.
  - Owner-driven: the owner has already asked (see 6), so close straight away.
  - After closing, call `md_window_forget()` only when you closed it yourself.

Find over the rendered view goes in `lib/renderedFind.ts`: walk the text nodes and mark matches with the CSS Custom Highlight API. Pure matching gets tests.

### 5. Entry points

- `FileTree.tsx`: the **Open in Markdown Window** menu item, shown only for `isMarkdownFile`.
- `FileTreeItem.tsx`: Cmd+click (macOS) or Ctrl+click (others) on a markdown file. Any other file opens as usual.
- The File pane and Preview pane title-bar menus: **Open in Markdown Window**.
- `keybindings.ts`: the action `open-markdown-window`. It is Unbound by default and appears in the command palette. It targets the focused markdown pane through `targetPaneId()`.
- All of these go through one `lib/openMarkdownWindow.ts` helper that calls `md_window_open`.

### 6. Lifetime hooks in the owning Window

- **Restore on open.** Opening a Workspace (the first `markWorkspaceOpened` for that id) calls `md_windows_restore(id)`.
- **Workspace close.** `closeWorkspace` calls `md_windows_dirty([id])` first. If any window has unsaved edits, it uses the existing Save / Discard / Cancel flow, listing the Markdown windows. "Save" emits `md-window-save` to those labels and waits for each to answer. It then calls `md_windows_close([id])`.
- **Profile switch and Window close.** These run the same check over all the Window's Opened workspaces before they go ahead. In `App.tsx`, `onCloseRequested` adds the count of dirty Markdown windows to `dirtyPaneCount` (`decideWindowClose`).
- **App quit.** Include dirty Markdown windows wherever the quit path counts dirty file panes today. **Check this route first**, because `decideWindowClose` covers the close of a single Window only.

### 7. Demo mode

`lib/demo` `mockInvoke`: `md_window_open` shows a toast ("Markdown windows need the desktop app"), and the other commands do nothing. No Tauri window API is reached directly; use `lib/appWindow.ts`.

### 8. Docs

- CLAUDE.md: add `markdown_windows.rs`, `MarkdownWindowApp`, `MarkdownRendered`, `openMarkdownWindow` to the architecture lists. Add a multi-window note: "`md-*` is a third label family; `is_profile_window_label` excludes it."
- ADR-0008's recipe for new auxiliary windows: add a pointer to ADR-0046 for Workspace-bound ones.

## Tests

- Rust:
  - store CRUD and the cascade when a Workspace is deleted
  - `is_profile_window_label` and `is_markdown_window_label`
  - restore skips and deletes rows whose file is missing
  - close cause: owner-driven vs. your own
- Frontend:
  - the `markdownLinks` classifier
  - `renderedFind` matching
  - `decideWindowClose` with dirty Markdown windows
  - `openMarkdownWindow` picks the target pane
  - the FileTree menu item shows for markdown files only
  - the Cmd/Ctrl+click branch
- **Runtime, in the real app:**
  1. Open from the explorer and toggle the view.
  2. Edit and save, and see the File pane on the same file reload.
  3. Close the Workspace, open it again: the window comes back with the same view and position.
  4. Quit and relaunch, then open the Workspace: the window comes back.
  5. Close the window yourself, reopen the Workspace: it does not come back.
  6. Delete the file while the app is closed: the window is not reopened.
  7. Close the Workspace with unsaved edits: you are asked.
  8. Switch Profile: the windows close, then return when you switch back.

## Deliberately not in v1

- Rich-text (WYSIWYG) editing in the rendered view.
- A side-by-side source + rendered view.
- Markdown windows for non-markdown files.
- Back/forward history when following links.
