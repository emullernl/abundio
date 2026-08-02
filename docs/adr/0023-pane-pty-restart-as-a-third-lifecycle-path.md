---
status: accepted
---

# Pane PTY restart is a third terminal lifecycle path

Abundio had two ways a terminal could end. **Switch-away** (`destroyTerminal`)
disposes the xterm instance but keeps the PTY alive and hands activity tracking to
a background listener, so a background workspace's status icons keep updating.
**Permanent close** (`teardownTerminal`) kills the process and every trace of it.
ADR-0020 covers the distinction and the invariant that holds it together: a live
background tracker always has a matching `panePtyMap` entry.

Per-workspace Environment Bundles introduced a third need. A PTY's environment is
fixed at `spawn_command` time, so changing a Bundle cannot affect a terminal that
is already open. "Apply to running terminals" has to kill each PTY and spawn a
replacement **in the same pane**, keeping the pane, its portal target and its
xterm instance alive — neither existing path does that.

**Decision:** `restartPanePty` is a first-class third path, with
`resetTerminal` (the pane menu's "Reset") delegating to it.

The two differ only in `preserveScrollback`: a restart parks the serialized
scrollback and re-emits it above the new prompt, a reset deliberately clears the
screen. Everything else — killing the old PTY, stopping background tracking,
re-seeding a stamped agent, resetting the startup-buffer state — is identical, so
sharing the implementation is what stops them drifting.

## Ordering is load-bearing

1. **Serialize scrollback first.** Anything else touches the terminal.
2. **`stopBackgroundTracking` before `pty.kill`.** A switch-away race can leave a
   tracker whose exit handler re-creates the activity entry we are about to
   remove.
3. **`removePty` / `removePane` before `initPty`, never after.** ADR-0020's
   invariant is "a live tracker has a matching `panePtyMap` entry"; `initPty`
   re-registers with the new ptyId. Removing afterwards would trip the dev-only
   assertion and genuinely break the invariant.
4. **`setPendingAgent` before `initPty`,** because `flushStartupBuffer` drains it.

## A latent bug this fixed

The previous `resetTerminal` reset `restoreData`, `ready` and the timing counters
but **not** `startupBuffer`, `startupFlushScheduled` or `startupShellReady`. After
the first spawn, `flushStartupBuffer` sets `startupBuffer` to `null` and leaves
`startupFlushScheduled` true — so on a second `initPty` the output handler's
`if (managed.startupBuffer)` guard was false and the flush early-returned. The
pane-menu "Reset" therefore restored no scrollback and never relaunched a stamped
agent. Both are prerequisites for restart, so the fix landed here.

`resetTerminal` also used `getActiveWorkspace()?.rootFolder` for the cwd, which is
wrong for any pane outside the front workspace — `TerminalPool` mounts panes for
every *opened* workspace. Both paths now resolve the pane's own workspace via
`findWorkspaceForPane`.

## Unmounted panes reuse cold start

A pane in a background workspace has a live PTY but no xterm instance, so there is
nothing to restart in place. `restartUnmountedPane` kills the process and blanks
the layout's `ptyId`; the next mount then takes the ordinary cold-start path.
Spawning eagerly instead would mean a second, divergent implementation of
everything `initPty` does.

## Consequences

- A restart gives an agent a **new session**, not a resumed one. The confirm
  dialog says so, and names the affected panes — which is why it is a bespoke
  dialog rather than `ConfirmDialog` (that component centres a single string at
  320px and cannot show a list).
- Restarts run **sequentially**. N shells starting at once all race `fit()` and
  `pty.resize` on shared xterm machinery — the class of race the reset filter
  exists to paper over.
- The layout's `node.ptyId` remains untrustworthy for "is this pane live": it is
  written back lazily. Live-pane resolution is
  `instance ?? panePtyMap`, never the layout.
