# The Fleet Console borrows live panes, resizes them, and keeps its own focus

The **Fleet Console** shows every agent-mode PTY in a Window as a grid of **Fleet tiles**. A terminal can be drawn in only one place (one xterm per PTY, moved between slots by `portalRegistry`), so a tile does not mirror its pane: it *borrows* it. While the Console is on, the tile is the terminal's only slot; turning the Console off hands it back.

We resize the PTY to the tile rather than shrinking the pane with CSS. Text stays readable and typing works, which matters because tiles are fully interactive (a Waiting prompt can be answered in the grid). The cost is accepted: every toggle resizes every Agent twice, and TUIs such as Claude Code redraw and may leave slightly messy scrollback.

The Console has its own **Focused tile** instead of driving the Window's **Focused pane**. Moving around the grid therefore never changes the Active workspace, its active Tab or its Focused pane; only **Switch to** does. This is why pane-level code that asks "is this pane on screen?" must ask which view is showing, not just which Tab is active.

## Considered options

- **Scale tiles with CSS, keep PTY size.** No redraws, but small tiles become unreadable and typing into a shrunk terminal is awkward. Rejected.
- **Scale when small, resize only the focused tile.** Best of both, but the focused Agent still redraws on every focus change, for the most complex design. Rejected.
- **Focus follows along** (focusing a tile makes its Workspace Active). Saves a Switch-to button, but the Workspace view would be silently rearranged behind the Console. Rejected.

## Consequences

- `portalRegistry` holds one target per pane, and a later `registerTarget` overwrites an earlier one. The Console's tile unregistering on exit would leave the pane with no slot at all, so the original slot must be restored (a stack of targets, or re-registration on Console exit).
- `isPaneVisible` (notification suppression) and notification-click routing must be view-aware; see the flagged ambiguity in `CONTEXT.md`.
- The **Overview bar** now has two navigation buttons (Statistics, Fleet Console). ADR-0005's rule still holds: it never mutates state.
