# Open plain file from the Git changes tab

## Context

Clicking a file row in the **Git changes tab** (`GitChangesTab.tsx` → `GitChangesFileList.tsx` → `GitChangesFileItem.tsx`) always opens a read-only diff view (`explorerStore.openDiff`). There is currently no way to jump straight to the plain file in the Monaco code editor from that tab — you'd have to separately locate the file in the Explorer tab and click it there (which calls `explorerStore.openFile`).

(Note: per `CONTEXT.md`, "git panel" is a retired term — the right sidebar hosts Git changes, Explorer, Search and PRs together, so this surface is the **Git changes tab**.)

The user wants an easy, low-friction way to open the original (non-diff) file directly from the Git changes tab, without disturbing the existing click-to-diff behavior. This is surfaced in **two places**:

1. A hover-revealed icon button on each row in the Git changes file list (fastest path, no need to open the diff first).
2. A matching icon button in the diff viewer's header toolbar, for when the diff is already open and the user decides they want the plain file too.

Both paths reuse the existing `explorerStore.openFile(workspaceId, filePath)` action — the same one the Explorer's file tree already uses for "Open in New Tab" (`FileTree.tsx:207`). It already handles focusing an existing tab for that file if one is open, so no new store logic is needed for the open itself.

`CONTEXT.md`'s `File pane` entry has already been updated to document that a diff-mode pane and a text-mode pane for the same path are tracked independently (`path` vs `diff:path`) and can coexist — this feature is the first to deliberately invite that.

## Design decisions from review

- **Deleted files are excluded.** Files with git status `D` have nothing left on disk to open as a plain file — `fs.readFile` would fail, and `explorerStore.loadFilePaneContent` (`explorerStore.ts:184-217`) currently swallows that failure silently, leaving a blank editable "text" pane with no error shown. Rather than fix that latent (pre-existing, out-of-scope) bug, both new affordances simply don't render for deleted files.
- **The deleted-file check needs a boolean threaded through the pane tree**, because the diff viewer's button doesn't have live access to `GitChangedFile.status` (only `diffSection` is persisted on `PaneNode`, and that survives app restarts / layout reloads while a transient `status` string would not naturally fit there). Add `isDeleted?: boolean` — a purpose-built boolean computed once at the call site where `GitChangedFile` is in scope (`file.status === "D"`) — rather than threading git's raw status-letter vocabulary into the generic pane-layout model.
- **Row layout reserves a fixed-width slot for the icon at all times** (opacity-only reveal on hover, matching `PullRequestItem.tsx:127`), including for deleted-file rows (rendered empty/invisible) — so every row truncates its filename at the same width and nothing reflows on hover or by status.
- **The row becomes a `<div role="button">`,** not a native `<button>`, to host a nested real `<button>` for the icon — matching the established pattern for exactly this problem elsewhere in the codebase (`WorkspaceItem.tsx:152-160`, `PullRequestItem.tsx:88-89`, `TabBar.tsx:130-135`).
- **Tooltip/label: "Open File"** (not "Open in New Tab") — these are icon-only buttons with no adjacent "Open Beside"/"Open Below" siblings to disambiguate against, unlike the Explorer's context menu.

## Implementation

### 1. `src/lib/types.ts`
- Add `isDeleted?: boolean` to `PaneNode`'s `"file"` variant (alongside `isDiff`/`diffSection`, lines 11-17). No DB migration needed — `PaneNode` is stored as a JSON blob, and the field is optional/backward-compatible like its siblings.

### 2. `src/stores/explorerStore.ts`
- Thread `isDeleted` through `openDiff` (line 351) and `registerFilePane` (line 227) into `FilePaneState` (alongside `diffOriginal`/`diffModified`), so `FilePane.tsx` can read it back off `paneState`.

### 3. `src/components/GitChanges/GitChangesFileItem.tsx`
- Convert the outer row from a native `<button>` to `<div role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => e.key === "Enter" && onClick()}>` (with a `biome-ignore lint/a11y/useSemanticElements` comment).
- Add a new `onOpenFile: () => void` prop and an `isDeleted: boolean` prop (or derive from `file.status === "D"` directly inside this component, since `file` is already a prop — simpler, no extra prop needed).
- Add a hover-revealed icon button using the `File` icon (from `../Icons`), styled like `PullRequestItem.tsx:123-139` (`opacity-0 group-hover:opacity-70 hover:!opacity-100`, fixed-width slot always reserved, empty when `isDeleted`). `title="Open File"`, `onClick={(e) => { e.stopPropagation(); onOpenFile(); }}`.

### 4. `src/components/GitChanges/GitChangesFileList.tsx`
- Add an `onOpenFile: (file: GitChangedFile) => void` prop to `Props`.
- Pass it through to each `GitChangesFileItem` as `onOpenFile={() => onOpenFile(file)}`, alongside the existing `onClick={() => onSelectFile(file)}` (line 143).

### 5. `src/components/RightSidebar/GitChangesTab.tsx`
- Add a `handleOpenFile(file: GitChangedFile)` function, mirroring `handleSelectFile`'s guard: if `activeWorkspaceId` is set, call `useExplorerStore.getState().openFile(activeWorkspaceId, file.path)` (no IPC call needed — this is a plain file read, already handled inside `openFile`).
- Pass `onOpenFile={handleOpenFile}` to `<GitChangesFileList>` (line ~196).
- Also pass `isDeleted: file.status === "D"` computed at the `handleSelectFile` call site into `openDiff` (new param), so it lands on the persisted `PaneNode`/`FilePaneState`.

### 6. `src/components/GitChanges/DiffViewer.tsx`
- Add an `onOpenFile?: () => void` prop — `undefined`/omitted when the file is deleted, hiding the button entirely (rather than a separate `isDeleted` prop plus internal conditional).
- When provided, render an icon button (the `File` icon) in the header next to the "Hide unchanged" toggle (lines 113-131), using the same hover-background treatment as the existing `ArrowLeft` back button (lines 86-101: inline `onMouseEnter`/`onMouseLeave`). `title="Open File"`.

### 7. `src/components/FileViewer/FilePane.tsx`
- In the `paneState.fileType === "diff"` branch (lines 281-297), compute `const realFilePath = paneState.filePath.replace(/^diff:/, "")` once and reuse it for both the existing `diff={{ ..., filePath: realFilePath }}` and the new handler. Pass:
  ```
  onOpenFile={
    paneState.isDeleted
      ? undefined
      : () => {
          const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
          if (workspaceId) useExplorerStore.getState().openFile(workspaceId, realFilePath);
        }
  }
  ```
  Both `useWorkspaceStore` and `useExplorerStore` are already imported in this file.

## Verification

- `pnpm check` and `pnpm build` (TypeScript) to confirm the new props/types are wired correctly.
- Manually verify in the running app (`pnpm tauri dev`, or `pnpm demo` if a real git workspace isn't handy):
  - Open a workspace with git changes including at least one modified and one deleted file. Hover a non-deleted row → the file icon appears; clicking it opens the plain file in a new editor tab, and clicking the row itself still opens the diff as before. Hover the deleted-file row → no icon appears, but the row's filename still truncates at the same width as other rows.
  - Open a diff view for a non-deleted file, click the new header icon button → the plain file opens; clicking it again when the file is already open just focuses the existing tab (via `openFile`'s existing find-or-create logic), rather than duplicating tabs. Open a diff view for a deleted file → no header icon appears.
  - Edit and save the file from its plain-text pane while its diff pane is also open → confirm the diff pane's content refreshes via the existing file-watcher path (`explorerStore.ts` `handleFsChange`, lines 629-745), since the two panes are independent but both track the same on-disk file.
  - Confirm keyboard activation (Tab to a row, press Enter) still opens the diff, and doesn't accidentally trigger the nested "Open File" button.
