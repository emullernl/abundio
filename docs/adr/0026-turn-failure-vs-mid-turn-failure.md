# Turn failures and mid-turn failures are different Errors

Not every **Error** ends a **Turn**. Copilot's `errorOccurred` fires while the Agent keeps
generating and is always followed by an `agentStop`, whereas Claude/Kimi/Qwen `StopFailure`,
Grok `Stop{reason:"error"}`, a PTY exit, and a failed shell command all mean the work is
over. We split the hook vocabulary accordingly — `"error"` (**Turn failure**) versus
`"errorMidTurn"` (**Mid-turn failure**) — and made acknowledging the red icon depend on which
one it was: a Turn failure rests at **Idle**, a Mid-turn failure returns the pane to whatever
it was doing.

## Why it mattered

Acknowledging an Error (a click or keystroke in the pane) unconditionally set **Idle**, and
nothing remembered that the Agent had been **Working**. For a hook-driven PTY that Idle was
permanent: `reduceOutput` short-circuits on `hookDriven`, and terminalManager doesn't even
dispatch an output event for such panes — it calls `touchLastOutput` directly. So the pane
read Idle for the rest of the turn while Copilot was still generating, until the next hook
arrived. The same gap swallowed a **Waiting** pane: Error overwrote Waiting, the keystroke
handler's answer branch requires `state === "waiting"`, so approving a permission prompt fell
through to the Idle path too.

## What we rejected

- **Defer the Error to turn end** — record "this Turn had a failure" and resolve `agentStop`
  to Error instead of Ready. Kills the bug outright and removes the mid-turn notification, but
  loses the immediate signal that something went wrong, which is the part worth keeping.
- **Ignore `errorOccurred`** — one line, but Copilot has no separate turn-failed hook and
  `agentStop` maps to `"ready"` unconditionally, so a genuinely failed turn would end purple.
  That trades a false Idle for a false Ready.
- **Restore Working whenever the pane was Working, for every Error kind** — no per-agent
  knowledge needed, but `StopFailure` panes would then show an amber spinner until the 30s
  `HOOK_IDLE_BACKSTOP_MS` tick, on the agents most people use.
- **End a Turn that had a mid-turn failure in Error rather than Ready** — `agentStop` firing at
  all is Copilot saying the turn completed, and it gives us no reason field to tell "recovered"
  from "limped to a stop". The mid-turn red already delivered the signal; the error count lives
  in the Turn telemetry.

## Consequences

- `preErrorState` on `StatusState` holds `"working" | "waiting" | null`, non-null only while
  the state is Error. It is mirrored out-of-band in `ptyActivityStore` (like `subagentState`),
  because `hydrate` rebuilds the reducer state from the entry on every dispatch — without the
  mirror the reducer change is a silent no-op.
- A **mouse click** on a restored **Waiting** leaves it Waiting: the `click` event runs
  `clearWaiting` before `clearError`, so it no-ops on Error. That is the honest outcome — the
  Agent really is still blocked, and a click is not an answer. A **keystroke** does resolve it:
  terminalManager acknowledges the failure first and re-reads the entry, so the key means what
  it would have meant without the failure.
- A Mid-turn failure raises no notification. It would be the first of two pings for one Turn,
  and the alarming one is the one the Agent handles itself.
- `agentTurnTracker` must not finalize the Turn on `errorMidTurn` — it counts the error and
  returns. Otherwise the acknowledging `error → active` transition opens a brand-new Turn
  started at click time and attributed to the user's mouse.
- OpenCode's `session.error` keeps the conservative turn-terminal mapping; its semantics are
  undocumented and nothing in the repo establishes that generation continues past it.
