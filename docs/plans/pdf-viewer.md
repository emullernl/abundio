# PDF viewer

Open PDF files inside Abundio: in a File pane, a File window, and a file
Orchestrator tab. Today a `.pdf` is a known binary extension, so it shows the
"unsupported file" panel and has no File window.

## Decisions (agreed 2026-11-24)

- **Where**: File pane, a new `pdf` File window kind, Orchestrator tabs, and
  Agent control's `file open` — by the same rules as any other file.
- **Renderer**: pdf.js (`pdfjs-dist`), bundled, and its `PDFViewer` component
  (`pdfjs-dist/web/pdf_viewer.mjs`). It looks the same on every platform;
  WebKitGTK on Linux has no built-in PDF viewer, so the webview's own viewer
  was not an option.
- **Features**: scroll, zoom (in / out / fit width), page jump, text
  selection and copy, find in the document (Cmd/Ctrl+F), and an outline panel
  shown only when the PDF has one. No thumbnails.
- **Read-only.** Pages are always white, as printed; only the toolbar and the
  background follow the theme.
- **Links**: a link to a page jumps there; an `http(s)` / `mailto` link opens
  in the default browser; any other link does nothing.
- **Remember** page and zoom across restarts, in File panes, File windows and
  Orchestrator tabs.
- **Changes on disk**: reload silently and keep page and zoom (clamped to the
  new page count). There are no unsaved edits to lose. A read that fails to
  parse (a build half way through writing the file) keeps the last good
  document; the next change event tries again.
- **Size**: PDFs may be up to 50 MB (other files stay at 5 MB). Still read
  whole through `fs_read_file` as base64, so Remote Hosts work unchanged.
- **Git changes**: a PDF's diff pane shows "binary file" and an **Open PDF**
  button that opens the file in a File pane. No visual diff.
- **Not in scope**: Workspace search does not look inside PDFs; no editing,
  annotations, forms or printing.

## Steps (one branch, one commit each)

1. **Rust read path.** `file_explorer.rs`: `fs_read_file` returns
   `fileType: "pdf"`, `mime: "application/pdf"`, base64 content, for `.pdf`
   up to `MAX_PDF_SIZE` (50 MB); larger stays `binary`. `pdf` stays in
   `BINARY_EXTS` so search keeps skipping it; the PDF branch runs first.
   Tests.
2. **Frontend types.** `fileType` gains `"pdf"` (`types.ts`, `explorerStore`,
   `FilePaneTitleBar` icon). `fileWindowKind.ts` and Rust `kind_for_path`
   gain `pdf` (ahead of the binary check); the shared-extension test in
   `file_windows.rs` covers it.
3. **`PdfView` component** (`components/FileViewer/PdfView.tsx`): takes base64
   bytes, a `PdfPosition` (`{ page, zoom }`, zoom a number or `"page-width"`)
   and `onPositionChange` (debounced). Toolbar: page box / count, zoom out /
   in / fit width, outline toggle (hidden when no outline), find. Uses
   `PDFViewer` + `PDFLinkService` + `PDFFindController` + `EventBus`. Link
   clicks in the annotation layer are intercepted: internal ones go to the
   link service, external ones through the app's existing external opener,
   the rest dropped. A new document (reload) keeps the position. Pure helpers
   (`lib/pdfView.ts`: clamp position, parse/validate a stored position,
   classify a link) with tests.
4. **File pane.** `FilePane` renders `PdfView` for `fileType === "pdf"`.
   The layout's `file` node gains `pdfPosition?: PdfPosition`, written by
   `setPdfPositionForPane` (like `setMarkdownViewForPane`; the layout is JSON
   in Rust, so no Rust change). `SplitContainer` passes it.
   `explorerStore.handleFsChange` re-reads a `pdf` pane on change.
5. **File window.** `FileWindowKind::Pdf` (`"pdf"`), validated like image.
   Migration `026_pdf_position.sql` adds `pdf_position TEXT` to
   `file_windows` and `orchestrator_tabs` (JSON, checked by Rust on write).
   `file_window_set_pdf_position`; `file_window_info` returns it.
   `FileWindowApp` gets a `PdfWindow`, re-read on change like `ImageWindow`.
   `openFileWindow` / `fileWindowTargetForPane` map a pdf pane to the kind.
   Window title as an image's. Command scope: desktop (like the other
   `file_window_*`).
6. **Orchestrator tabs.** `orchestrator_tab_set_pdf_position` in
   `orchestrator.rs`, a `host_api.rs` dispatch arm, listed in
   `lib/hostApiCommands.ts` and `commandScope.ts`. `OrchestratorFileTabs`
   passes the tab's position to `FilePane`.
7. **Agent control & Git changes.** `fileOpen.ts` accepts PDFs (it follows
   `fileWindowKindFor`). A diff pane of a `.pdf` shows the binary notice with
   **Open PDF**.
8. **Docs.** GLOSSARY (done during the design), CLAUDE.md module list
   (`PdfView`, `lib/pdfView.ts`), demo fixtures if a pdf is cheap to add.

## Risks

- **pdf.js worker** loads from the bundle (`?url` import); no CSP is set, so
  nothing blocks it. A test-time mock replaces pdf.js in jsdom.
- **Migration**: back up `abundio.db` (+ `-wal`, `-shm`) before the first
  run of a build carrying `026`.
- **Big files**: 50 MB becomes ~67 MB of base64 over IPC, held twice briefly.
  Acceptable for now; ranged reads are the follow-up if it hurts.
