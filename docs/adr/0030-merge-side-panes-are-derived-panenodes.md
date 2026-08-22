---
status: accepted
---

# Merge side panes are derived `PaneNode`s

The **Merge view** is composed from Abundio's own pane tree: a new `{ type: "mergeSide"; id; sourcePaneId; side }` `PaneNode`, read-only, bound to a source pane, laid out above the editable result pane that ADR-0029 already provides. It is not a merge-editor widget, and it deliberately echoes ADR-0001's shape for the markdown **preview pane**.

## Why this shape

VS Code's merge editor cannot be reused. There are **zero** files matching `*merge*` in the entire `monaco-editor` ESM tree; it lives in `vs/workbench/contrib/mergeEditor/` — the workbench, not the editor — wired into instantiation services, context keys and observables the standalone distribution does not have. Porting it means porting a slice of the workbench.

It also is not needed. VS Code's merge editor has to *compute* its result document, auto-merging the non-conflicting changes and marking the rest. **Git already did that**: the conflicted working file is that document. So the expensive half was done before Abundio saw the file, and what remains is side panes over `git_conflict_file`'s stages — which ADR-0029's work already fetches.

ADR-0001's reasoning for `preview` transfers unchanged: a side pane isn't "a file open here", so overloading `type: "file"` with a flag would be wrong, and the explicit `sourcePaneId` link is what makes lifecycle coupling tractable. The pane-tree helpers were generalised structurally (`Extract<PaneNode, { sourcePaneId }>`) so both variants share one implementation rather than growing a parallel set.

Mapping a conflict block onto its lines in a stage document is a **monotonic forward search**, not a diff. Git built each conflict region out of the real stage content, so the side text appears verbatim; advancing a cursor past each match disambiguates repeated content. This avoids `defaultLinesDiffComputer` — and therefore avoids a deep `monaco-editor/esm` import, which is unsafe here because the repo has no `loader.config({ monaco })` and a second bundled monaco would carry a different model registry and `Emitter` class.

## Consequences

- **The persisted layout JSON gains a second derived node shape.** Orphan pruning on workspace load is generalised to cover both variants. An older build reading a newer layout hits `UnknownPaneFallback` and renders a placeholder rather than crashing.
- **Side panes are read-only.** Every accept action stays in the result pane, where the buffer and dirty state live. This is a deliberate reduction from VS Code, whose per-side checkboxes duplicate what our code lenses already do.
- **Sync is one-directional** — the result pane's caret drives the sides. Bidirectional sync would only give the two ways to fight.
- **The view tears itself down** when the path stops being unmerged, consistent with ADR-0029's index-derived rule, so finishing or aborting the merge needs no explicit close path.
- **Base is hidden by default** and unavailable for an add/add conflict, which has no stage 1. This matches VS Code's own default.
- **A block that cannot be located gets no highlight**, and the failed match does not advance the cursor, so it cannot desync later blocks.
