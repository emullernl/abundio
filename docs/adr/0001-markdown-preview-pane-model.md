# Markdown preview is a dedicated `PaneNode` type linked to its editor

When a markdown file is opened in the Monaco editor, a live preview opens as a
separate pane beside it. We model that preview as a new `PaneNode` variant —
`{ type: "preview"; id; sourcePaneId }` — rather than overloading the existing
`type: "file"` node with an `isPreview` flag. A preview owns no file of its own;
it is a derived view of its **source pane**'s live, unsaved buffer, and the
explicit `sourcePaneId` link is what makes "follow the editor when it opens a new
markdown file", lifecycle coupling, and live-buffer sync tractable. The `file` +
`isPreview` flag alternative was rejected because a preview isn't "a file open
here", and a disk-content-only variant was rejected because the preview must
reflect unsaved edits.

## Consequences

- The layout JSON persisted in SQLite gains a new node shape. Changing this model
  later requires a layout migration.
- On workspace load, any persisted `preview` node whose `sourcePaneId` no longer
  resolves must be pruned — analogous to how stale `ptyId`s are cleared on load.
- Auto-open of previews must fire only on user-initiated file opens, never on
  layout restore (restored layouts already carry their `preview` nodes).
- Editor and preview are otherwise ordinary, independently-placeable panes: the
  link is logical, not structural, so the drag/split system needs no changes.
