# Fix: a second mid-turn failure resolves to Idle instead of restoring the turn

## Context

With Copilot, a mid-turn error painted the pane red. Clicking it correctly put the pane back
to **Working**. A minute later, still inside the same turn, a second error appeared — but
clicking that one dropped the pane to **Idle**, even though the Turn had not ended.

ADR-0026 (commit b1ae204) introduced `preErrorState`: a **Mid-turn failure** remembers what
the pane was doing, so acknowledging it restores Working or Waiting; a **Turn failure**
records nothing and rests at Idle. The reducer logic is correct. Two things outside it are not,
and behind the second sits a structural defect in how the idle backstop ends a **Turn**.

### Cause 1 — the click path is not the reducer's `click` event

`statusReducer.ts:632` defines `case "click": markIdle(clearError(clearWaiting(s)))`. The
`clearWaiting` runs **first** on purpose, so it no-ops on Error and a restored Waiting survives
the click. ADR-0026:44-48 documents exactly this.

Nothing dispatches `{ kind: "click" }`. The real click is two handlers on two elements, running
in the **opposite** order:

1. `terminalManager.ts:1306-1314` — a native `mousedown` on `term.element` calls `clearError`
   then `markIdle`.
2. `TerminalSlot.tsx:199-208` — React `onMouseDown` on the pane container, delegated to the
   React root, therefore **after**, calls `clearWaiting`.

For a mid-turn failure recorded while the pane was **Waiting**: `clearError` → waiting →
`markIdle` (no-op) → `clearWaiting` → **idle**. Copilot's `notification{permission_prompt}` and
`preToolUse{ask_user}` both map to `"waiting"` (`agentHookMap.ts:45-71`, `:271-278`), so the
pane can easily have been Waiting at the second failure.

### Cause 2 — the idle backstop closes the Turn while pretending the Agent said so

`errorMidTurn` only records a memory from `working`/`waiting` (`statusReducer.ts:356-362`). A
hook-driven pane silent for 30 s flips `working → ready` via the backstop
(`statusReducer.ts:566-571`) — asserted as desirable in `statusReducer.test.ts:1014-1026`. An
`errorMidTurn` landing on that `ready` pane records `null`, so the click rests at **Idle**.

The real problem is one layer down. `noteState` at `agentTurnTracker.ts:248`:

```ts
if (state === "ready") return finalize(ptyId, "stop", now);
```

The backstop tick does two jobs that should never have been welded together: repaint the icon
(a *heuristic* — reversible, cheap if wrong) and write a permanent `agent_turn` row claiming
`endReason: "stop"` (*authoritative* — irreversible, expensive if wrong). On a hook-driven pane
the second is a guess dressed as an observation: an authoritative `agentStop` **is** coming.

Everything downstream has been patched around that. ADR-0026's "don't finalize on
`errorMidTurn`" was patch one. Keeping the first failure's `preErrorState` (b1ae204) was patch
two. A naive fix for Cause 2 would be patch three — and worse, it would fabricate telemetry:
with the Turn already finalized by the backstop, restoring Working on the click reaches
`noteState("active")` with no open Turn and **opens a brand-new Turn started at click time and
attributed to the user's mouse** — precisely what ADR-0026:51-53 was written to prevent.

## Decisions taken (grilling session)

- Fix the click ordering **and** the backstop's dishonesty; don't special-case the symptom.
- The click handler survives in `TerminalSlot` (it has the gates and the tests); the
  `terminalManager` listener is deleted.
- PR #140's click-dismisses-Waiting behaviour **stays**, so `click` keeps `clearWaiting` first.
- `errorMidTurn` from `ready` restores Working; from `idle` it does not.
- The tick cause gains a `rule` discriminator so the two backstop paths are distinguishable.
- No backfill of historic rows is possible — stated as a consequence, not solved.

## Commit 1 — dispatch one `click` event instead of three

**`src/stores/ptyActivityStore.ts`** — add a `click(ptyId)` action beside `clearError` /
`clearWaiting` / `markIdle` (`:388-410`), dispatching `applyStatusEvent(ptyId, { kind: "click" })`;
declare it on the store interface near `:134`. `applyStatusEvent` already handles hydrate, the
`preErrorStates` sync and the `StatusChange` emission.

**`src/components/Terminal/TerminalSlot.tsx:199-208`** — `handleMouseDown` calls
`click(ptyId)` in place of `clearWaiting(ptyId)`. Both gates (left button, landed inside
`innerRef`) and all four #140 tests stay put. Update the comment block at `:186-198`.

**`src/lib/terminalManager.ts:1304-1321`** — delete the listener, its registration, its cleanup
entry (`:1325+`), and the dead `console.warn` branch.

Two bugs close for free: `terminalManager`'s listener had **no button gate**, so a right-click
on a red pane silently acknowledged the Error before the context menu opened; and one gesture
now emits one `StatusChange` rather than an `error → waiting → idle` stutter the tracker has to
absorb.

Verified rather than assumed: the mousedown does bubble from xterm's element to `TerminalSlot`
— the reported bug *is* `TerminalSlot`'s `clearWaiting` firing on a real xterm click.

**Docs.** Amend **ADR-0026:44-48**: the click ordering it describes was aspirational; state
that a single `click` event now dispatches it. Amend **ADR-0015**: its invariant *"agent-mode
Waiting is overridden only by a keystroke or the next hook"* has been false since #140 — record
the click as a third dismissal path, and its consequence (a clicked-then-unanswered permission
prompt reads Idle until answered, because `reduceOutput` short-circuits on `hookDriven` and
`reduceTick` early-returns on non-`working`).

**Tests.** `TerminalSlot.test.tsx:110-148` keep passing unchanged. Add to
`ptyActivityStore.test.ts`: mid-turn failure recorded from Waiting → `click` → pane is
`waiting`, **not** `idle` (the reported bug); plain Waiting → `click` → `idle`; `ready` →
`click` → `idle`; Turn-failure Error → `click` → `idle`.

## Commit 2 — only a turn-start hook may open a Turn on a hook-driven pane

**`src/lib/agentTurnTracker.ts`**, in the `subscribeStatusChange` handler (not inside
`noteState`, which has no `cause` and is called directly by tests): when `next.hookDriven` and
the transition would open a Turn, require `cause.kind === "hook" && cause.transition ===
"working"`. Anything else reaching Working on a hook-driven pane must not open a Turn.

Blast radius is small and exactly right: a hook-driven pane cannot reach Working via the byte
heuristic anyway (`reduceOutput` short-circuits on `hookDriven`, `statusReducer.ts:448`), so
this blocks only a tick-opened and an acknowledgement-opened Turn — both fabrications. The
documented pre-hook flood case at `agentTurnTracker.ts:414-419` is untouched, because that pane
is not yet `hookDriven`.

**Tests.** `agentTurnTracker.seam.test.ts` — a click acknowledging an Error on a hook-driven
pane with no open Turn opens none; the existing pre-hook-flood case still opens its Turn.

## Commit 3 — the idle backstop ends a Turn as *presumed*, not *stopped*

**`src/stores/ptyActivityStore.ts:610-615`** — the tick scanner already holds `before`, so it
can name which backstop rule fired:

```ts
cause: {
  kind: "tick",
  now,
  rule: before.activeSubagents.length > 0 ? "subagent_drain" : "idle_backstop",
}
```

Widen the `tick` variant of `StatusEvent` (`statusReducer.ts:121-159`) accordingly; the reducer
ignores the field.

**`src/lib/agentTurnTracker.ts`** — on `next.state === "ready"` with `cause.kind === "tick"`:

- `rule === "idle_backstop"` → `finalize(ptyId, "presumed_end", getLastOutputAt(ptyId) ?? now)`.
  Back-dating to last activity keeps 30 s of silence out of `workingMs`.
- `rule === "subagent_drain"` → unchanged `"stop"` at `now`. Here the turn end **was** observed
  — the `agentStop` arrived and ADR-0022 held it — and that tail is Working time ADR-0022 bills
  on purpose, so it must not be back-dated.

No migration: `end_reason` is a bare `TEXT` column with no CHECK
(`012_add_agent_turns.sql:37`), the frontend types it `string | null` (`ipc.ts:379`), and
nothing renders it.

**Docs — new `docs/adr/0027-the-idle-backstop-is-a-presumed-turn-boundary.md`.** Covers Rules A
and B, why `rule` belongs on `cause` (`CONTEXT.md:151` already concedes the hole, defining
`cause` as *"the Status event that drove it (or the idle backstop)"* — this names which
backstop rather than adding a new exception), and the rejected alternatives:

- *Don't finalize at all on a hook-driven backstop* — a genuinely dropped `agentStop` (the relay
  is fire-and-forget `curl -m 2`) leaves the Turn open for hours and the row lands as
  `session_end` with inflated wall-clock. An early boundary that admits it's early beats an
  unbounded late one.
- *Reopen the Turn when an `errorMidTurn` proves the backstop wrong* — the row is already
  written; needs a delete-and-rewrite path in `workspace_store` and a resurrectable-Turn
  concept. The label carries the same information for free.
- *Have `clearError` consult `openTurns` instead of guessing via `preErrorState`* — the most
  honest answer to "what should the red icon return to?", but it reverses the one-way
  StatusChange seam into a cycle, since `openTurns` is itself derived from the status machine.

Consequences to record: an `errorMidTurn` with no open Turn still drops its error count;
`subagent_drain` deliberately keeps `"stop"`; and **historic rows cannot be backfilled** — the
information to tell a backstop boundary from a real one was never stored, so `presumed_end`
starts at the deploy date and any analysis spanning it sees a discontinuity.

**Docs — `CONTEXT.md`.** Add near **Turn failure** / **Mid-turn failure**:

> **Presumed end**: A **Turn** boundary Abundio *inferred* from silence rather than observed
> from an **Agent hook** — the pane went quiet past the idle backstop window and the Agent never
> said the Turn ended. Recorded as its own end reason so a presumed boundary is never read as an
> observed one, and timed from the last activity rather than the moment we gave up. Distinct
> from the Subagent-drain backstop, where the turn-finished hook *was* observed and only the
> tail length is inferred (ADR-0022). See ADR-0027.
> _Avoid_: timeout (implies we imposed a limit on the Agent), stale (collides with
> `SUBAGENT_STALE_MS`), abandoned (suggests the user walked away).

And extend **Turn**'s definition with the third ending — a Turn may also end at a **Presumed
end**, which is neither finishing nor failing.

**Tests.** `agentTurnTracker.seam.test.ts` — a silence-rule tick finalizes as `presumed_end`
with `endedAt === lastOutputAt`; a `subagent_drain` tick still finalizes as `stop` at `now`; a
real `agentStop` is unaffected. Existing seam cases asserting `"stop"` from a tick need updating.

## Commit 4 — a mid-turn failure on a backstopped pane restores Working

**`src/lib/statusReducer.ts:352-363`** — in the `errorMidTurn` branch, widen the recorded
`preErrorState`:

| pane state at failure | recorded | why |
|---|---|---|
| already `error` | keep the first memory | unchanged (b1ae204) |
| agent `working` / `waiting` | itself | unchanged |
| agent `ready` | **`"working"`** | new — the backstop only *guessed* the Turn ended; a turn-continuing failure proves it had not |
| agent `idle` | `null` | `idle` is an observed intent (ESC-cancel, an authoritative `idle` hook, or a click-dismissed Waiting); a late error must not undo it |
| shell mode | `null` | unchanged |

If the Agent really is silent, the 30 s backstop simply re-fires on the next tick after
acknowledgement.

**Docs.** Amend **ADR-0026**: add the `ready` case, and record the accepted gap — dismiss a
Waiting pane with a click (#140), then a mid-turn failure, then acknowledge → Idle, because
that `idle` is indistinguishable from a cancel.

**Tests.** `statusReducer.test.ts` (ADR-0026 block, `:832-1030`) — `errorMidTurn` from `ready`
records `"working"` and click/keystroke restores Working; from `idle` and from shell mode still
records `null`. Update `:899` *"records nothing when the pane was not busy"* for the new `ready`
case. Keep `:884` as the regression anchor — it now covers a production path.

## Verification

1. `pnpm test`, `pnpm check`, `pnpm build`.
2. **Runtime, not just tests** — the whole bug is two handlers firing in the wrong order, which
   no unit test exercises. `pnpm tauri dev`, open a Copilot pane:
   - trigger a permission prompt → **waiting** (sky blue)
   - let a tool call fail so `errorOccurred` fires → **red**
   - click the terminal → must return to **waiting**, not idle
   - answer the prompt → **working**; force a second failure → red; click → **working**
   - let `agentStop` arrive → **ready**
3. Unchanged paths in the same session: clicking a plain waiting pane still dismisses to idle;
   clicking a ready pane still dismisses to idle; **right-clicking a red pane opens the context
   menu without acknowledging it** (newly correct); clicking the title bar or starting a pane
   drag does not clear the dot.
4. **Telemetry** — back up the DB first (`cp abundio.db` plus `-wal`/`-shm`). Leave a hook-driven
   agent idle past 30 s to trip the backstop, then
   `sqlite3 abundio.db "select end_reason, started_at, ended_at, working_ms from agent_turn order by rowid desc limit 5"`:
   expect `presumed_end` with `ended_at` at last activity, not 30 s later. Then click the red
   pane and confirm **no new row** appears (Rule A).

## Not in scope

A repeat `errorMidTurn` while already in Error projects an identical legacy entry, so
`changed === false` at `ptyActivityStore.ts:307` and no `StatusChange` fires — meaning
`agentTurnTracker.ts:433` never increments `errorCount` for the second failure. Telemetry only;
does not affect the icon. Separate fix.
