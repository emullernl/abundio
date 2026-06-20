# Terminal teardown on close is distinct from unmount on workspace switch

When a terminal pane's component unmounts, `destroyTerminal` disposes the xterm UI but
**keeps the PTY alive** and starts a background activity tracker (a separate
`onOutputRaw`/`onStatus` listener pair in `terminalManager`'s module-level
`backgroundTrackers` map) so status dots for Opened-but-inactive workspaces keep updating —
the snappy-switching keep-alive of ADR-0002. Permanently closing a Tab, Pane, or Workspace
must do the opposite: stop the background tracker, dispose the xterm **without** re-starting
one, kill the PTY, and purge the pane's `ptyActivityStore` entries. Every close path
(`closeWorkspace`, `closeTab`, `closePaneNow`, `deleteWorkspace`) routes through a single
`teardownTerminal(paneId)` that does exactly this; `destroyTerminal` remains the switch-away
keep-alive path.

## Consequences

- There are **two** per-PTY registries: `ptyActivityStore` (state that feeds the Overview
  bar counts) and `terminalManager.backgroundTrackers` (live Tauri listeners). Removing an
  entry from the first without stopping the second leaks a listener and — because the
  tracker's exit handler calls the unguarded `recordError` (re-creates a missing entry,
  unlike the guarded `recordExitSuccess`) — can **re-create** the entry just removed,
  inflating the Overview bar's Error counts intermittently. This was a latent bug in
  `closeWorkspace` even before `closeTab`/`closePaneNow` were fixed.
- `teardownTerminal` must run **synchronously** from the close handler. Unmounting the
  pane's component also schedules a deferred `destroyTerminal`; running teardown first
  disposes the instance so that deferred call early-returns (`instances.get` → undefined)
  instead of re-starting a tracker on the killed PTY.
- Background tracking is correct for *switch-away* (the Workspace stays Opened, its PTYs
  must still count) and wrong for *close/delete*. The two look alike — both unmount the
  component — but have opposite intent, so the distinction lives in explicit close handlers,
  not in the unmount path.
- The live ptyId is resolved as `instances.get(paneId)?.ptyId ?? panePtyMap[paneId]`, never
  from the layout's `node.ptyId`: `panePtyMap` is written at spawn (`registerPane`) ahead of
  the layout write-back and survives instance disposal.
- **Invariant:** a live background tracker for a ptyId ⟺ a `panePtyMap` entry for its pane.
  Trackers (`startBackgroundTracking`) and `panePtyMap` entries (`registerPane`) are each
  created in exactly one place and torn down together by `teardownTerminal`, so every live
  tracker is reachable by iterating a workspace's pane ids and looking each up in
  `panePtyMap`. This is what makes a directly-deleted workspace (sidebar bulk-delete /
  worktree-sync, which skip `closeWorkspace`) tear down cleanly, and why panes never rendered
  this session need no handling — they have no tracker, no `panePtyMap` entry, and
  `loadWorkspaces`' `clearPtyIds` already blanked their layout ptyId. A dev-only assertion
  warns if the invariant is ever broken, rather than reconciling with a runtime sweep.
