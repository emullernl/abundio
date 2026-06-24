# Persist agent mode across terminal restarts (clear on manual exit)

## Context

When a terminal pane enters **agent mode** (an AI coding agent like Claude Code is
running in it), Abundio should remember to re-launch that agent the next time the
pane's terminal starts (app restart, workspace reopen). The one exception: if the
user **manually exited** the agent (e.g. `/exit`, `Ctrl+C`), the agent should *not*
be re-launched next time.

Before this change the behavior was asymmetric and buggy:

- **Entry persistence was incomplete.** A pane's `agentId` was stamped onto the
  persisted layout only when the agent was launched via Abundio's UI — picker, split
  (`useSplitPane.splitPaneWithChoice`), new tab (`createTab`), workspace creation
  (`seedFocalPane`), or the pane context menu (`TerminalSlot.handleLaunchAgent` →
  `stampAgentOnPane`). An agent started by **manually typing** `claude` at the shell
  was detected at runtime (`setAgentPty`) but never persisted, so it was forgotten on
  restart.
- **Exit never cleared persistence.** When agent mode ended — shell `command_end` or
  the `SessionEnd` hook — `clearAgentPty` updated only runtime state. The persisted
  `agentId` stayed, so on the next `loadWorkspaces` / `closeWorkspace`,
  `seedPendingAgentsForLayout` (`workspaceStore.ts`) re-launched an agent the user had
  deliberately quit.

The "still-running at shutdown ⇒ restart" case already worked: app-quit /
workspace-close kills the PTY abruptly (`pty.onStatus` "exited") **without** firing
`command_end` or `SessionEnd`, so `clearAgentPty` is not called and the `agentId`
correctly persists. Teardown also unlistens before killing, so no stray clear fires.

**Goal:** make persistence symmetric — stamp `agentId` on *every* entry into agent
mode, and clear it exactly when agent mode ends while the shell survives (= manual
exit). Scope: remember all entries, including manually-typed / hook-detected agents.

## Design

Agent mode is toggled in two store actions, `setAgentPty` / `clearAgentPty`
(`ptyActivityStore.ts`), both always called from `terminalManager.ts`'s per-PTY
listeners — where the `paneId` closure variable is in scope. This mirrors the existing
**cwd** pattern (`stampCwdOnPane(paneId, ...)` called right next to `setCwd`): pair
each `setAgentPty` with `stampAgentOnPane(paneId, id)` and each `clearAgentPty` with
`stampAgentOnPane(paneId, undefined)`.

`stampAgentOnPane` (`workspaceStore.ts`) and `setAgentId` (`paneTree.ts`) already
existed and handle both set and clear (`undefined` removes the field). Centralizing the
clear in terminalManager's `clearAgentPty` sites covers *all* launch paths (picker,
split, context-menu, manually-typed), since agent exit for any of them flows through
these same listeners.

## Changes

### 1. `src/lib/paneTree.ts` — make `setAgentId` idempotent

`setAgentId` previously always returned a new node for the set case, so repeated stamps
would churn the DB. Added a short-circuit mirroring `setCwd` so unchanged stamps are
no-ops and `stampAgentOnPane`'s `stamped !== layout` guard skips the write:

- Set case: `if (tree.agentId === agentId) return tree;`
- Clear case: `if (tree.agentId === undefined) return tree;`

This lets the hook path (which calls `setAgentPty` on *every* hook event) call
`stampAgentOnPane` unconditionally without extra DB writes.

### 2. `src/lib/terminalManager.ts` — stamp on enter, clear on exit (4 sites)

All four are inside `initPty`, with `paneId` in scope (`useWorkspaceStore` already
imported):

- **Detection enter** (`command_start` → `matchTitleToAgent` matched): after
  `setAgentPty(currentPtyId, matched.id)`, `stampAgentOnPane(paneId, matched.id)`.
- **`command_end` exit** (inside the `detectionMode === "agent"` branch): after
  `clearAgentPty(currentPtyId)`, `stampAgentOnPane(paneId, undefined)`.
- **Hook enter** (non-clear transition): after `setAgentPty(currentPtyId, hookEvent.agent)`,
  `stampAgentOnPane(paneId, hookEvent.agent)`.
- **Hook clear / `SessionEnd` exit**: after `clearAgentPty(currentPtyId)`,
  `stampAgentOnPane(paneId, undefined)`.

No change needed in `TerminalSlot.handleLaunchAgent` (already stamps on enter; exit is
now handled centrally) or in the existing `createTab` / `seedFocalPane` /
`splitPaneWithChoice` launch-time stamps.

### Deliberate simplification

Any agent termination while the shell survives (manual `/exit`, `Ctrl+C`, or a
non-zero crash) clears the persisted `agentId` — we do not try to distinguish a crash
from a deliberate quit. This matches the user's mental model ("the agent stopped") and
the existing runtime logic, which already calls `clearAgentPty` on `command_end`
regardless of exit code. Re-launching is a one-click action.

## Tests

- `src/lib/__tests__/paneTree.test.ts` — `setAgentId` returns the same reference when
  the agentId is unchanged (set and clear cases); still updates/removes when changed.
- `src/stores/__tests__/workspaceStore.test.ts` — `stampAgentOnPane` persists an
  agentId, and `stampAgentOnPane(paneId, undefined)` removes a previously-stamped
  `agentId` from the persisted layout so `collectAgentPanes` is empty (a restart's
  `seedPendingAgentsForLayout` becomes a no-op).

## Verification

1. `pnpm test`, `pnpm check`, `tsc --noEmit` — all green.
2. `pnpm tauri dev`. In one pane, launch Claude via the picker; in another, type
   `claude` manually. Confirm both panes show agent mode.
3. **Restart-keeps-agent:** quit the app (Cmd+Q) while both agents are running, relaunch
   → both panes re-launch their agent.
4. **Manual-exit-forgets:** relaunch, `/exit` (or `Ctrl+C`) out of one agent back to the
   shell, then quit + relaunch → that pane comes up as a plain shell; the other
   (still-running at quit) re-launches its agent.
5. Repeat step 4 with **close workspace → reopen** instead of app quit (exercises
   `closeWorkspace`'s `seedPendingAgentsForLayout`).
