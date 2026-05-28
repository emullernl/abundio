# PTY status: shell-mode is Idle/Working/Error only, asymmetric propagation, distinct Working visual

The five PTY status terms — **Idle, Working, Ready, Error, Waiting** — were originally defined as Agent states. They now describe any PTY, but with **different state sets per mode**: an agent-mode PTY uses Agent hooks to enter Working/Ready/Error/Waiting; a shell-mode PTY uses the shell-integration `command_start` / `command_end` OSC markers and is limited to **Idle / Working / Error** — a clean exit returns to Idle directly, with no Ready hop and no completion notification. The previous `shellActivityStatus` opt-in toggle is removed; shell-mode status is always tracked, degrading silently to permanent Idle when shell integration isn't sourced.

**No shell Ready: success is silent.** A shell's output is itself the "you have something to look at" signal — the prompt has returned, the result is rendered on the screen. A separate purple notification state would be redundant. So `recordExitSuccess` for a shell-mode PTY skips the Ready transition and goes straight to Idle, the OS notification on clean exit goes away (only Error notifies for shells), and the Overview bar's `Terminals` section has no Ready tile (only Idle / Working / Error). Agents keep Ready unchanged — agent turns are conversational and the acknowledgement signal earns its place.

**Propagation is asymmetric.** Agent-mode PTYs propagate every state to their Tab and Workspace dot. Shell-mode PTYs propagate **only Error**; Working contributes as Idle for rollup. So a Tab whose only non-idle pane is a shell running a long-lived watcher reads green at the Tab level (and at the pane level shows the breathing chevrons); the same shell exiting non-zero turns its Tab red. The per-pane indicator is the always-true signal — the Tab dot is a *summary* tuned to "is anything I should look at happening?", and a healthy long-running shell isn't.

**Working amber diverges visually by mode.** Agent-Working keeps the broken double-ring spinner. Shell-Working renders as a breathing triple-chevron `>>>` (SVG) at the pane title bar and in the Overview bar's `Terminals → Working` tile. The color is identical; the glyph is not. This is intentional: at-a-glance you can tell whether amber belongs to an agent (chewing through a turn) or a shell (running your command).

## Considered alternatives

- **Keep shell Ready (as a pane-only signal).** A clean shell exit would still flash purple at the pane and fire a notification when blurred. Rejected because the shell's output is itself the completion signal — a separate notification state is redundant attention, and removing it sharpens the rule "success is silent, only Error gets your attention".
- **Drop the purple visual but keep the OS notification.** Notification-only Ready that never renders. Rejected as a half-measure that complicates the state machine without earning its keep.
- **Always-propagate shell states.** Tabs would light up amber for every running command. Rejected because a workspace with a backgrounded `npm run dev` would never sit at Idle, defeating the Tab dot's purpose as a "needs attention?" summary.
- **Exclude shell-mode PTYs from rollup entirely (not even Error).** Cleanest rule, but it hides genuine failure — a `git push` that errored in a background pane should still surface on the Tab. Rejected.
- **Retire the spinner and use `>>>` for both agent and shell Working.** Single visual vocabulary, but loses mode disambiguation at the pane level — and Agent-Working is well-established. Rejected.

## Consequences

- `PtyActivityState` value `"active"` in code remains; the doc canonically uses **Working**. Renaming the code value is a deferred follow-up (see CONTEXT.md "Flagged ambiguities").
- The Overview bar's `Terminals` section shows three tiles: Idle, Working, Error. The `showShellActivityDetail` prop and the `shellActivityStatus` setting are removed.
- The `idleScanner` in `stores/ptyActivityStore.ts` no longer branches on focus for shell-mode PTYs — a Working shell whose output stops simply returns to Idle, regardless of which pane has focus. The focus-driven Ready transition remains for agent-mode only.
- `classifyShellExit` in `lib/activityGate.ts` returns `"idle"` (not `"ready"`) on a clean shell exit. Error classification is unchanged.
- The OS notification path (`ptyActivityStore.ts:503`) does not need an explicit shell exclusion — shell-mode PTYs simply never reach `state === "ready"`, so the existing `state`-based branching naturally silences them.
- The Tab/Workspace aggregator (`computeTabDotStatus`, `computeWorkspaceDotStatus`) must learn the PTY's mode to apply the asymmetric Error-only propagation rule. The pane-mode signal already exists (shell-mode vs agent-mode is tracked for hook routing); the aggregator needs to consume it.
