# A markdown File pane has its own rendered view; the Preview pane is on request

A markdown File pane, like a markdown File window, now shows one view at a time: **rendered** (read-only, the live buffer) or **source** (Monaco). It opens rendered by default, the view is stored on the pane's `file` node (`markdownView`; absent means "follow the setting"), and the same holds for file Orchestrator tabs (a `view` column on `orchestrator_tabs`). Opening a markdown file no longer adds a Preview pane beside it. This reverses part of ADR-0001, which made a Preview pane open automatically beside every markdown file: reading a document was the common case, and two panes showing one file wasted half the Tab.

The Preview pane itself is kept, opened only from the pane menu (Open Preview Beside), because a live preview beside the source is still the best way to edit a document. So there are now two ways to see rendered markdown in a Tab, on purpose: the pane's own rendered view for reading, a Preview pane for editing side by side.

## Considered options

- **Retire the Preview pane.** Rejected: it loses side-by-side editing, and saved layouts holding `preview` nodes would need a layout migration.
- **Keep auto-opening the Preview pane as well.** Rejected: the file would show the same rendering twice.

## Consequences

- Every rendered-view rule must hold in both places — File pane and File window — so the rendered surface and the Rendered / Source switch are shared components.
- The Settings ▸ Editor option keeps its slot but changes meaning: **Open markdown rendered** (on by default). A user who had turned auto-open off keeps it off, and their markdown now opens in source.
- `abundio file open --preview` now means "open it rendered, whatever the setting"; it no longer adds a Preview pane. A `--line` still shows source, because a line means something only in the source.
- A link in the rendered view opens the target in a new Tab (or the Tab already showing it), never in the same pane, so a pane never replaces a file that has unsaved edits. A File window's links open File windows, and an Orchestrator tab's open Orchestrator tabs.
