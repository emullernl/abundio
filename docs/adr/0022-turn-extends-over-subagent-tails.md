---
status: accepted (extends the Turn boundary of ADR-0018)
---

# A Turn extends over background Subagent tails

Agents can spawn **Subagents** (CONTEXT.md) — Claude Code, Copilot, Codex and Qwen
emit subagent start/stop hooks; OpenCode runs child sessions with a `parentID`.
Background Subagents can **outlive the turn-finished hook**: Claude Code's `Stop`
fires when the main agent's turn ends, while `SubagentStop` for a background
subagent arrives asynchronously later. ADR-0018 defined the Turn as
prompt-submitted → turn-finished hook, and the status machine flipped the pane to
**Ready** on `Stop` — so a pane read "done" (and its Turn finalized) while
delegated work was still running. No agent's turn-finished payload carries a
"pending background work" flag, so Abundio must track Subagent lifecycles itself.

**Decision:** delegated work is the Turn's work. The status machine holds the pane
in **Working** while its Subagent set is non-empty — the turn-finished hook with
live Subagents defers Ready ("stop held") until the last `SubagentStop` drains the
set — and because Turn telemetry finalizes on the `→ Ready` transition
(ADR-0018), the Turn's duration and Working time naturally include the subagent
tail. No telemetry plumbing changes.

## Why not a display-only hold

The alternative was to keep the Turn boundary at the `Stop` hook and hold only the
icon. That requires decoupling `agentTurnTracker` from the `→ Ready` transition
(finalize on the hook `cause` even when the state stays Working) and creates a
state that cannot exist today: a Working pane with no open Turn. It also records a
duration the user would dispute — the Statistics overlay would say the Turn took
40 s while the pane visibly worked for six minutes. Working time that includes
delegated work is the truthful number.

## Consequences

- **A new prompt always cuts the extension short.** Turns never overlap; a
  Subagent surviving into the next Turn accrues its remaining time to the *new*
  Turn (accepted imprecision — no per-Turn subagent bookkeeping).
- **The 30 s idle backstop is suppressed while the Subagent set is non-empty.**
  Background Subagents produce no pane output, so output-quietness proves nothing;
  the backstop would silently defeat the hold. It resumes unchanged once the set
  is empty (still covering a dropped main `Stop`).
- **A lost `SubagentStop` must not wedge the pane.** The relay is fire-and-forget
  (`curl -m 2`); entries older than 30 minutes (`SUBAGENT_STALE_MS`) are pruned by
  the periodic Tick, and session end / PTY exit / ESC-cancel / the next prompt
  clear the set instantly. Trade-off: a lost stop can show a stale amber spinner
  for up to 30 min on an untouched pane; a shorter window would falsely flip
  long-running legitimate Subagents (deep research/review routinely run 10–20 min)
  to Ready — lying "done" is worse than lying "busy", since the user's next
  interaction clears the latter.
- **Ready — and its desktop notification — now means "everything finished",**
  including delegated work. That is the point.
- **A failed turn never resurrects.** `StopFailure` → Error clears the hold flag;
  Subagent stops afterwards only drain the set, never flip Error to Ready.
  Acknowledging that Error (click/keystroke) drops the **set** too, mirroring the
  ESC-cancel path: a failed Turn has no tail worth tracking, and an orphaned set
  would otherwise hold the *next* Turn's Stop as Working until `SUBAGENT_STALE_MS`
  (2h). A **mid-turn** failure is the exception — the Turn continues, so it keeps
  both the set and the hold. See ADR-0026.
- **Coverage is per-agent best-effort:** Copilot's built-in `general-purpose`
  agent emits no subagent hooks (its background tasks keep the old behavior), and
  Copilot identifies subagents by `agentName` only, so concurrent same-named
  subagents may release the hold early. Gemini's subagents are synchronous tool
  calls — no tail exists, nothing to hold.
