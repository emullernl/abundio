# Replace MDXEditor with Monaco + add a linked markdown preview pane

## Context

Today `.md` / `.mdx` files open in `MarkdownEditor.tsx` — a WYSIWYG editor built on
`@mdxeditor/editor` (a heavy dependency bundling CodeMirror + Lexical). Non-markdown
text files open in `CodeEditor.tsx` (Monaco). `FilePane.tsx` routes between them via
`isMarkdownFile()`.

We want to:

1. Route markdown files to the existing Monaco `CodeEditor` instead of MDXEditor.
2. When a markdown file is opened, also open a **live preview** in a separate pane
   beside it — rendering Mermaid diagrams, switchable light/dark, and printable.
3. Remove MDXEditor entirely (component, CSS, dependency, orphaned settings).

Design decisions and rationale are recorded in
[`docs/adr/0001-markdown-preview-pane-model.md`](../adr/0001-markdown-preview-pane-model.md).
Canonical terms (**File pane**, **Preview pane**, **Source pane**) are in `CONTEXT.md`.

### Resolved design

- **Pane model** — new `PaneNode` variant `{ type: "preview"; id; sourcePaneId }`.
  A preview owns no file; it is a derived view of its **source pane**'s live,
  unsaved buffer.
- **Layout** — auto-open wraps the source file pane in
  `{ type: "split"; direction: "vertical"; ratio: 0.5; first: <source>; second: <preview> }`.
  `direction: "vertical"` renders side-by-side (`SplitContainer.tsx:69-77`).
- **Coupling** — editor and preview are independent, freely draggable/splittable
  panes; the link is logical (`sourcePaneId`), not structural. No drag-system changes.
- **Auto-open** — default-on, gated by a new `markdownPreviewAutoOpen` setting.
  Manual toggle via `Cmd+Shift+M` + context menu + command palette. Closing a
  preview sets in-memory per-source-pane suppression (not persisted) so it does not
  re-spawn until manually reopened.
- **Lifecycle** — source switches to another `.md` → preview follows; source
  switches to non-markdown → preview closes; source pane closes → preview closes.
- **Rendering** — `@uiw/react-markdown-preview` (GFM + code highlighting,
  GitHub document styling). Mermaid via a custom `code` component calling the
  already-installed `mermaid@11`. This component becomes the lazy-loaded chunk.
- **Theming** — the preview always renders **light** (`data-color-mode="light"`,
  Mermaid `"default"`) — a "printed paper" look — regardless of the app theme.
  No per-preview theme control. _(Originally planned as a switchable
  `markdownPreviewTheme` setting; simplified to always-light after the grilling.)_
- **Printing** — rebuild `markdownPrint.ts` around the preview's `.wmde-markdown`
  DOM. Entry points: preview pane title-bar button + context menu, and source file
  pane context menu (opens preview first if missing). Always renders light theme +
  light Mermaid.
- **Out of scope (v1)** — scroll sync. Markdown files in Monaco default to
  word-wrap on, overriding the global `editorWordWrap` setting.

## Approach

Build the pane-tree plumbing first (the keystone), then the routing swap, then the
preview component, then printing, then tear down MDXEditor last so the app stays
runnable throughout.

The persisted layout is opaque JSON on the Rust side (`workspace_store.rs`), so the
new node type needs **no Rust changes** — only the TypeScript `PaneNode` type and
the code that walks it.

---

### Phase 1 — `PaneNode` plumbing

**`src/lib/types.ts`** — add the variant:

```typescript
export type PaneNode =
  | { type: "terminal"; id: string; ptyId: string; agentId?: string; cwd?: string }
  | { type: "file"; id: string; filePath: string; isDiff?: boolean; diffSection?: GitChangedFile["section"] }
  | { type: "preview"; id: string; sourcePaneId: string }
  | { type: "split"; id: string; direction: "horizontal" | "vertical"; ratio: number; first: PaneNode; second: PaneNode }
```

**`src/lib/paneTree.ts`** — audit every helper for exhaustiveness over node types.
Add helpers:
- `findPreviewForSource(root, sourcePaneId)` — locate a source pane's preview.
- `findOrphanPreviews(root)` — preview nodes whose `sourcePaneId` does not resolve
  in the tree.
- Ensure traversal/close/split helpers treat `preview` as a leaf (like `terminal` /
  `file`).

**`src/components/Terminal/SplitContainer.tsx`** — add a `PreviewLeaf` branch
alongside `TerminalLeaf` / `FileLeaf`, rendering the new `<PreviewPane>` (Phase 3).

**`src/hooks/useSplitPane.ts`** — `closePane` / `closePaneNow` must, when closing a
**file** pane, also close any preview bound to it. When closing a **preview** pane,
clear the suppression flag is *not* needed (closing sets it). Navigation
(`Cmd+Shift+Arrow`) should treat preview panes as normal navigable panes.

**Add unit tests** in `src/lib/__tests__/paneTree.test.ts` for the new helpers and
for close-cascades (closing a file pane removes its preview; closing a preview
leaves the file pane).

### Phase 2 — Workspace-load hardening

CLAUDE.md: "Stale `ptyId`s are cleared on workspace load." Find that pass (workspace
load logic in `stores/workspaceStore.ts` / `hooks/useWorkspace.ts`) and add an
**orphan-preview prune** in the same pass: drop any `preview` node whose
`sourcePaneId` does not resolve in its tab's tree, collapsing the split.

This must run on layout restore. Auto-open (Phase 4) must **not** — restored layouts
already carry their persisted `preview` nodes.

### Phase 3 — Preview pane component

Install `@uiw/react-markdown-preview` (and its peer `react-markdown` stack if not
transitively provided).

**`src/components/FileViewer/PreviewPane.tsx`** (new) — lazy-loaded:
- Reads the live unsaved buffer of `sourcePaneId` from the same store `FilePane`
  writes editor content to (the per-pane `paneState.content`). Re-renders on change.
- Renders `<MarkdownPreview source={buffer} components={{ code: MermaidCode }} />`
  inside a `data-color-mode="light"` wrapper — always light, no theme prop.
- Title bar: print button (no theme toggle).
- If `sourcePaneId` resolves to a pane whose file is no longer markdown, render
  nothing — the close is driven by Phase 4 logic, not the component.

**`src/components/FileViewer/MermaidCode.tsx`** (new) — replaces the old
`MermaidBlock.tsx`. Intercepts ` ```mermaid ` fences, calls `mermaid.render()` with
the light (`"default"`) theme. Non-mermaid code falls through to the default
highlighted renderer.

### Phase 4 — Routing, auto-open, settings

**`src/stores/settingsStore.ts`**:
- Add `markdownPreviewAutoOpen: boolean` (default `true`).
- Remove `markdownZoom` and `markdownThemeColors` (orphaned once MDXEditor is gone —
  only `MarkdownEditor.tsx` + this store reference them). Stale localStorage keys are
  harmless.

**`src/components/FileViewer/FilePane.tsx`** (lines ~236-256) — replace the
`isMarkdownFile` → `LazyMarkdownEditor` branch so markdown files render via
`CodeEditor`. Pass a flag so `CodeEditor` forces word-wrap on for markdown,
overriding `editorWordWrap`. Remove the `LazyMarkdownEditor` import and the
`markdownEditorPromise` preload.

**Auto-open logic** — on a user-initiated file open (explorer click, file
quickopen, git changes), if the opened file is markdown and `markdownPreviewAutoOpen`
is set and the source pane is not suppressed and has no existing preview: wrap the
source pane in a vertical split with a new `preview` node. Locate the existing
open-file path (explorerStore + the code that builds `type: "file"` nodes) and hook
in there — *not* in the layout-restore path.

**Follow / close-on-non-markdown** — when a file pane's `filePath` changes: if the
new file is markdown, the bound preview re-renders automatically (it reads by
`sourcePaneId`); if non-markdown, close the bound preview.

**Suppression** — an in-memory module-level `Set<sourcePaneId>` (pattern: like
`lib/dragPaneStore.ts`, a plain module, not Zustand). Set on preview close, cleared
on manual reopen. Not persisted.

**Manual toggle** — `src/lib/keybindings.ts`: register `Cmd+Shift+M` (Ctrl on
Win/Linux) → toggle preview for the focused file pane. Add the same action to the
file pane context menu (`FilePane.tsx`) and `CommandPalette.tsx`. Update the
keybindings table in `CLAUDE.md`.

### Phase 5 — Printing

**`src/lib/markdownPrint.ts`** — rewrite. Current impl greps MDXEditor's
`.abundio-prose`; new impl operates on the preview pane's `.wmde-markdown` element.
Keep the existing behavior of cloning into a hidden container, injecting print CSS,
re-rendering Mermaid in light (`theme: "default"`), `window.print()`, cleanup on
`afterprint`.

Entry points:
- Preview pane title-bar print button + preview pane context menu → print that
  preview's DOM.
- Source markdown **file pane** context menu "Print" → if no preview is open,
  open one first, then print (single shared print code path).

### Phase 6 — MDXEditor teardown (last)

- Delete `src/components/FileViewer/MarkdownEditor.tsx`,
  `src/components/FileViewer/MarkdownEditor.css`, and the old
  `src/components/FileViewer/MermaidBlock.tsx`.
- Remove `@mdxeditor/editor` from `package.json`.
- Verify `src/components/FileViewer/prismGlobal.ts` does not need `@codemirror/*`
  (it imports `@codemirror` per grep — confirm whether that path is still reachable
  after MDXEditor removal). If unused, remove `@codemirror/search` and
  `@codemirror/view` from `package.json`.
- Run `pnpm install`, `pnpm build`, `pnpm check`, `pnpm test`.
- Grep for any remaining `MarkdownEditor` / `markdownZoom` / `markdownThemeColors`
  references.

## Files touched

| File | Change |
|------|--------|
| `src/lib/types.ts` | add `preview` `PaneNode` variant |
| `src/lib/paneTree.ts` | preview-aware helpers, exhaustiveness audit |
| `src/lib/__tests__/paneTree.test.ts` | new helper + close-cascade tests |
| `src/components/Terminal/SplitContainer.tsx` | `PreviewLeaf` branch |
| `src/hooks/useSplitPane.ts` | close-cascade (file → its preview) |
| `src/stores/workspaceStore.ts` / `src/hooks/useWorkspace.ts` | orphan-preview prune on load |
| `src/components/FileViewer/PreviewPane.tsx` | new — lazy preview component |
| `src/components/FileViewer/MermaidCode.tsx` | new — replaces old MermaidBlock |
| `src/stores/settingsStore.ts` | add `markdownPreviewAutoOpen`, remove 2 orphaned ones |
| `src/components/FileViewer/FilePane.tsx` | route markdown → Monaco, auto-open, context menu |
| `src/components/FileViewer/CodeEditor.tsx` | word-wrap-on override for markdown |
| `src/lib/keybindings.ts` | `Cmd+Shift+M` toggle |
| `src/components/CommandPalette.tsx` | toggle-preview command |
| `src/lib/markdownPrint.ts` | rewrite around `.wmde-markdown` |
| `package.json` | + `@uiw/react-markdown-preview`; − `@mdxeditor/editor`, `@codemirror/*` |
| `CLAUDE.md` | keybindings table + architecture notes |
| `MarkdownEditor.tsx` / `.css` / `MermaidBlock.tsx` | deleted |

## Risks / watch-outs

- **Auto-open vs. layout restore** look identical at the data layer but must behave
  oppositely. Gate auto-open strictly on user-initiated opens.
- **Orphan pruning** — persisted previews can outlive their source across sessions;
  prune on load alongside the stale-`ptyId` pass.
- **Live buffer source of truth** — the preview must read the *unsaved* editor
  buffer, not disk. Confirm which store holds live `paneState.content` and that the
  preview can subscribe to it by source pane id.
- **Mermaid async render** — the print path must wait for Mermaid to finish before
  `window.print()`, same as the current impl does.
- **`prismGlobal.ts`** — confirm its `@codemirror` import is dead before removing the
  dependency.
