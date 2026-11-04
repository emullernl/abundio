# Plan: File windows (open any supported file in a separate window)

## Context

Today a **Markdown window** (ADR-0046) can open only `.md`/`.mdx` files. We are widening it into a **File window**: a separate OS window that can show anything a File pane can show. See ADR-0049 and the `File window` entry in `GLOSSARY.md` (already updated).

## Design decisions (settled with the user)

- **Kinds:** `text` (editable; markdown also has rendered/source views), `image` (read-only), `diff` (live working-tree diff, read-only), `commit-diff` (one file in one commit, frozen, read-only). A `.diff`/`.patch` file counts as `text`, or as whatever a File pane opens it as.
- **Which kind a file gets** is whatever a File pane would open for it. Binary, unsupported, folders and submodules have no File window, so the menu item is **hidden** there.
- **At most one window per file and kind.** A text window and a diff window of the same file can be open together.
- **Every kind is remembered** and reopens with its Workspace. A live diff with nothing left shows "no changes".
- **Label:** "Open in Separate Window". From a pane, it opens what that pane shows. The Git **Row menu** gets two items, *Open Diff in Separate Window* and *Open File in Separate Window*. Each follows the state rules of its in-pane twin.
- **Entry points:** the same as today (Explorer menu and Cmd/Ctrl+click, File/Preview pane ⋯ menu, both Row menus, command palette, shortcut). No new title-bar buttons.
- **Shortcut:** keep the action id `open-markdown-window` and change only its label.
- **Raise:** the File window raise covers every kind.
- **Title:** `notes.md`, `app.ts — Diff`, `app.ts @ a1b2c3d`.
- **Code names:** rename the table to `file_windows` and add a `kind` column. **Keep the `md-<uuid>` labels**, the `markdown-window.json` capability and the label checks.

## Points settled during implementation

1. **The live diff's section is not part of its key.** `explorerStore` keys a live diff pane `diff:<path>`, one per file whichever section opened it. The window copies this: the row stores the latest `diff_section`, and opening it again from another section updates the row and asks the open window to re-read (`file-window-reload`).
2. **Explorer Cmd/Ctrl+click** now opens every file that has a File window (text and images). Approved by the user.
3. **Titles** follow the pane names (`app.ts (diff)`, `app.ts @ a1b2c3d`) rather than a new spelling.
4. **The kind comes from `file_window_info`**, not the window URL, like the file path already did.
5. **A live diff re-reads when its file changes, on `git-change` (commits, branch moves) and when its window gains focus.** Focus is the only signal for a bare `git add` from a terminal, because `.git/index` is deliberately not watched. Only the newest read may land, so an overtaken one never shows the old section under the new title (PR #246 review).

## Commits (one branch, in order)

### 1. Migration: `markdown_windows` → `file_windows`
- Back up the DB first (`abundio.db` plus `-wal`/`-shm`).
- New migration `018_file_windows.sql`: rename the table and add `kind TEXT NOT NULL DEFAULT 'text'`, `diff_section TEXT NULL` and `commit_oid TEXT NULL`. Change the primary key to `(workspace_id, file_path, kind, commit_oid)`. SQLite cannot change a primary key in place, so use the table-rebuild pattern, with the FK PRAGMAs at the very start and end (see `split_fk_pragmas`).
  - A NULL in a primary key column breaks uniqueness, so store `''` for "no commit".
- Rust tests: old rows survive with `kind = 'text'` and keep their labels and views; a text row and a diff row of one path can both exist; two commits of one path give two rows.

### 2. Rust: `markdown_windows.rs` → `file_windows.rs`
- Rename the module and types (`MarkdownWindowStore` → `FileWindowStore` etc.). Keep `is_markdown_window_label` and the `md-` prefix, with a comment pointing to ADR-0049.
- Replace `validate_markdown_path` with `validate_file_path(root, path, kind)`:
  - `text`/`image`: an existing file inside the Workspace folder, with a type a File pane would open (same text/image test `fs_read_file` uses for `fileType`).
  - `diff`: the path may be deleted on disk (a deleted file still has a diff), but it must be inside the Workspace folder.
  - `commit-diff`: inside the Workspace folder, plus a valid oid. No on-disk check.
- The `open` command takes `{ workspaceId, filePath, kind, diffSection?, commitOid? }`. Rename the commands to `file_window_*` / `file_windows_*` in the same commit as the IPC change in commit 3.
- Dirty tracking and `unsaved_edits.rs`: only `text` windows can be dirty. Quit dialog wording: "Markdown window" → "window".
- Tests: validation per kind, key uniqueness, and restore returning every kind.

### 3. Frontend IPC and the single entry point
- `lib/ipc.ts`: `markdownWindows` → `fileWindows`, with the new `open` arguments.
- `lib/openMarkdownWindow.ts` → `lib/openFileWindow.ts`:
  - `openFileWindow(workspaceId, target)`, where `target` is a union per kind.
  - `fileWindowTargetForPane(paneId, layout, filePanes)` replaces `markdownFileForPane`. It returns a target for a text, image or diff File pane, a Commit diff pane or a Preview pane, and `null` for binary panes, terminals and so on.
  - `clickOpensFileWindow` (see open point 2).
  - Pure, with unit tests for each pane type.
- `lib/markdownWindowRaise.ts` → `lib/fileWindowRaise.ts` (only renamed).

### 4. Window root: `MarkdownWindowApp.tsx` → `FileWindowApp.tsx`
- Read `kind` (and `diffSection`/`commitOid`) from the window URL or the restore payload, then branch:
  - `text`: today's Monaco source view. Markdown keeps the rendered/source toggle, find bar and print. Other text gets only the source view, and its toolbar hides the markdown-only buttons.
  - `image`: `ImageViewer`, reading through `fs_read_file` (base64 + mime). Re-read when the file watcher reports a change.
  - `diff`: `DiffViewer`, fed by `git_file_diff(cwd, path, section, baseBranch)`. Re-fetch on the window's file watcher events. The git **status fingerprint** is not needed: the pane already refreshes this way, in `explorerStore` around line 997. Show "No changes" when both sides are equal.
  - `commit-diff`: `DiffViewer`, fed once by `git_commit_file_diff`. No watcher.
- Window title from the kind (the decision above). Put the pure title helper in `lib/fileWindowTitle.ts`, with tests.
- `main.tsx` keeps routing `md-*` labels to this root.
- `components/MarkdownWindow/` → `components/FileWindow/`. The toolbar takes `kind` and shows only the controls that apply.

### 5. Menus and labels
- Every "Open in Markdown Window" becomes "Open in Separate Window". Today it is in `CommandPalette.tsx`, `PreviewPaneTitleBar.tsx`, `FilePane.tsx`, `Explorer/FileTree.tsx` and `keybindings.ts` (the label only, **not the id**).
- Show the item when `fileWindowTargetForPane`, or the file's type, says a File window exists. Otherwise hide it.
- `lib/gitRowMenu.ts`: two items. Diff: disabled on a Conflicted row (like Open Diff); on a Commits row it opens `commit-diff`. File: disabled on a deleted path, enabled on a Conflicted row, and on a Commits row opens the file as it is on disk now. Both are hidden on submodules and on files with no File window. Update `gitRowMenu` tests.
- `CommitsSection.tsx`: wire the commit-diff item.

### 6. Docs sweep
- `CLAUDE.md`: the `markdown_windows.rs` and `components/MarkdownWindow/` entries, the `md-*` multi-window gotcha (say it now covers every File window kind, labels still `md-`), and the `lib/openMarkdownWindow.ts` / `markdownWindowRaise` mentions.
- ADR-0046: add a status line, `amended by ADR-0049`.

## Verification
- `cd src-tauri && cargo test`; `npx --no-install vitest run`; `npx --no-install tsc --noEmit`; `pnpm check`.
- In the real app (`pnpm tauri dev`), with the DB backed up first:
  1. An existing remembered Markdown window reopens with its size, position and view kept, which shows the `md-` labels survived.
  2. Open a `.ts` file in a window, edit it and save. The File pane shows it as an external change. Quitting with unsaved edits shows the dialog.
  3. Open a PNG in a window, then overwrite the PNG. The window updates.
  4. Open a live diff window from a Git changes row, edit the file in a terminal, and see the diff update. Stage everything and see "No changes" or the staged section, depending on open point 1.
  5. Open a commit diff window from a Commits row, then open the same file at another commit. Two windows.
  6. Close and reopen the Workspace. Every window comes back. Switch Workspaces and the windows are raised without taking focus.
  7. A binary file and a submodule show no "Open in Separate Window" item.
  8. A custom rebind of the old shortcut still works.
