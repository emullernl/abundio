# The idle backstop is a presumed Turn boundary, not an observed one

The idle scanner's Working→Ready backstop was doing two jobs that should never have been
welded together: repainting the **status icon** so a pane doesn't spin forever — a *heuristic*,
reversible, cheap if wrong — and calling `finalize(ptyId, "stop")`, which writes a permanent
`agent_turn` row claiming the **Agent** said it finished — *authoritative*, irreversible,
expensive if wrong. On a hook-driven **PTY** the second is a guess dressed as an observation:
an authoritative turn-finished hook **is** coming, the tick just got impatient.

We split the two. The backstop still ends the **Turn** — that part of the model is unchanged
and load-bearing (it is why telemetry rides the **Status transition** output rather than the
**Status event** input) — but it now ends it as a **Presumed end**, timed from the last
observed activity rather than the moment we gave up. And a hook-driven pane will only *open* a
Turn on a turn-start hook.

## Why it mattered

Everything downstream had been patched around the lie, one instance at a time. ADR-0026's
"don't finalize on `errorMidTurn`" was the first patch. Keeping the *first* **Mid-turn
failure**'s `preErrorState` was the second. The third would have been a special case for this:
once the backstop has finalized a Turn, a Mid-turn failure that then restores **Working** on
acknowledgement reaches `noteState("active")` with no open Turn and opens a **brand-new Turn
started at click time and attributed to the user's mouse** — exactly the failure ADR-0026
blocked on the other path.

Separately, a backstop row was indistinguishable from a real one: same `endReason: "stop"`,
and 30 s of silence billed into `workingMs` and `durationMs`.

## The two rules

**Only an authoritative signal may open a Turn on a hook-driven pane.** `noteState` opens a
Turn on any arrival at Working; once `hookDriven`, it now requires
`cause.kind === "hook" && transition === "working"`. The blast radius is small by construction:
such a pane cannot reach Working via the byte heuristic (`reduceOutput` short-circuits on
`hookDriven`), so this blocks only tick-opened and acknowledgement-opened Turns, both
fabrications. The documented pre-hook TUI-flood case is untouched — that pane is not yet
`hookDriven`, so its heuristic Working still legitimately opens the Turn.

**A backstop boundary is labelled and back-dated.** `endReason: "presumed_end"`, ended at
`getLastOutputAt(ptyId)` rather than `now`. `end_reason` is a bare `TEXT` column with no CHECK
and nothing renders it, so this needed no migration. `finalize` floors the end time at the
Turn's latest timer origin — a Turn that produced no output carries a `lastOutputAt` from
before it began, and without the floor that would bill negative time.

Two ticks can produce Working→Ready and they are **not** equivalent, so the scanner names which
rule it tripped in the tick's `cause` (`backstopRule`, an exported pure helper):

- `idle_backstop` — pure silence. Nothing was observed. **Presumed end**, back-dated.
- `subagent_drain` — the stale prune emptied the **Subagent** set and released a *held*
  turn-finished hook. That hook **was** observed; only the tail length was inferred, and
  ADR-0022 bills that tail as the Turn's Working time on purpose. Keeps `"stop"` at `now`.

Only the scanner holds the pre-tick state, so the answer has to ride the cause rather than be
re-derived downstream. `cause` is otherwise the machine's *input*, and "which backstop fired"
is arguably an outcome — but the existing definition already concedes this hole ("the Status
event that drove it, *or the idle backstop*"). Naming which backstop makes an existing
exception explicit rather than adding a new one. The alternative, a `peekSubagentCount` helper
the tracker calls, reintroduces exactly the out-of-band read-ordering fragility the Status
transition seam was built to remove.

## What we rejected

- **Don't finalize at all on a hook-driven backstop** — keep the Turn open and let the real
  turn-finished hook, session end, or PTY exit close it. The cleanest separation, but the relay
  is fire-and-forget (`curl -m 2`), so a genuinely dropped hook leaves the Turn open for hours
  and the row eventually lands as `session_end` with inflated wall-clock. An early boundary
  that admits it is early beats an unbounded late one.
- **Reopen the Turn when an `errorMidTurn` proves the backstop wrong** — the row is already
  written, so this needs a delete-and-rewrite path in `workspace_store` and a
  resurrectable-Turn concept. The label carries the same information for free.
- **Have `clearError` consult `openTurns` instead of guessing via `preErrorState`** — the most
  honest answer to "what should acknowledging the red icon return to?", since the tracker knows
  authoritatively whether a Turn is open. Rejected because it reverses the one-way Status
  transition seam into a cycle: `openTurns` is itself derived from the **Status machine**.

## Consequences

- **Historic rows cannot be backfilled.** The information needed to tell a backstop boundary
  from a real one was never stored, so `presumed_end` starts at the deploy date and any
  analysis spanning it sees a discontinuity.
- An `errorMidTurn` arriving with no open Turn still drops its error count — unchanged from
  ADR-0026, and now reachable via a preceding presumed end.
- The `subagent_drain` boundary keeps `"stop"` deliberately, so its row still carries the tail
  ADR-0022 bills. It is the one Working→Ready tick that is *not* a guess about whether the Turn
  ended, only about when.
- Rule A means a hook-driven pane that somehow loses its turn-start hook records nothing for
  that Turn rather than recording a Turn with a fabricated start. Silence over fiction: a
  missing row is visibly missing, a wrong one is not.
- Rule A made a latent seam gap load-bearing, so it is now explicit: `applyStatusEvent` emits a
  **Status transition** for a turn-start hook even when the projected entry is unchanged. Turn
  telemetry has no other way to learn a new Turn began, and the tracker's `startsWork` exception
  only ever worked by luck — the known case (a TUI flood tripping the byte heuristic into
  Working before the first hook) also flipped `hookDriven`, so the entry changed. On an
  already-hook-driven pane sitting at Working it emitted nothing and the next Turn went
  unrecorded, reachable via an acknowledged Mid-turn failure or simply a queued prompt.
