# Subagent-Aware Pane Status

## Context

When an **Agent** spawns background **Subagents** (CONTEXT.md) and its turn-finished
hook fires, Abundio flips the pane to **Ready** even though delegated work is still
running. Claude Code's `Stop` payload carries no "pending background work" field — no
agent's turn-finished payload does — so Abundio must track Subagent lifecycles itself
and hold the Ready transition while any Subagent is alive.

The governing decision is **ADR-0022**: delegated work is the Turn's work. The status
machine holds the pane in **Working** while its Subagent set is non-empty, and because
Turn telemetry finalizes on the `→ Ready` transition (ADR-0018,
`agentTurnTracker.ts:248`), the Turn's duration and Working time naturally include the
subagent tail — no telemetry plumbing changes.

## Decisions (locked with the user via grilling)

| # | Decision | Rationale |
|---|----------|-----------|
| Turn boundary | **Turn includes the subagent tail**; a new prompt cuts the extension short (tail accrues to the new Turn — accepted imprecision). | ADR-0022. Truthful Working time; zero telemetry changes; turns never overlap. |
| Visual | The hold shows the existing amber **Working** spinner — no new state, no new glyph. | State stays within the canonical five; a distinct "delegating" visual can later be derived from `stopHeldForSubagents && activeSubagents.length > 0`. |
| Wedge-breaker | `SUBAGENT_STALE_MS = 30 min` prune on Tick; session end / PTY exit / ESC / next prompt clear the set instantly. The 30 s `HOOK_IDLE_BACKSTOP_MS` ready-flip is **suppressed** while the set is non-empty. | Background Subagents produce no pane output, so quietness proves nothing. Lying "busy" (clearable by one interaction) beats lying "done". |
| Scope | All six agents, per the signal table below. | Gemini needs nothing (synchronous subagents); the rest get wired. |
| Copilot gaps | **Accepted & documented**: the built-in `general-purpose` agent emits no subagent hooks (its background tasks keep the old behavior); tracking is keyed by `agentName` (no instance id), so concurrent same-named subagents may release the hold early. | Strictly better than today for named/custom/fleet agents. |
| Qwen | **Verified diverged** (installed 0.15.6 binary speaks Claude-style events; zero `BeforeAgent`/`AfterAgent` hits): replace its Gemini-style provisioning wholesale. | Pre-existing silent breakage — Abundio's qwen hooks never fire on current qwen. Re-provisioning auto-strips the dead entries. |

## Signals per agent (researched mid-2026)

| Agent | Subagent signal | Work |
|---|---|---|
| Claude Code | `SubagentStart` / `SubagentStop` hooks; payload `agent_id`, `agent_type`. Background subagents outlive `Stop`. | Register + track by `agent_id` |
| Copilot CLI | `subagentStart` / `subagentStop` (camelCase); payload `agentName` only. `general-purpose` emits neither. | Register + track by `agentName`; document gaps |
| Codex CLI | `SubagentStart` / `SubagentStop` in `hooks.json` (turn-scoped — likely no tail today) | Register + track (cheap, future-proof) |
| Qwen 0.15.6 | Claude-style vocabulary incl. `SubagentStart` / `SubagentStop` (verified in binary) | Replace Gemini-style provisioning with Claude-style + subagent events |
| OpenCode 1.17.13 | Plugin events: `session.created`/`session.updated` carry `info.parentID`; deprecated `session.idle` (currently mapped → ready) carries only `sessionID` | Forward `event.properties`; route child-session events via the Subagent set |
| Gemini CLI | None — subagents are synchronous tool calls; `AfterAgent` cannot fire mid-subagent | No changes |

## Pipeline facts the design leans on (verified)

- The relay scripts and `hook_server.rs` are **event-name-agnostic** and already forward
  the full hook stdin JSON as `AgentHookEvent.payload` → no Rust transport changes.
- Provisioning **self-upgrades**: `provision_merge_settings` strips all Abundio groups
  (relay-path marker) and re-adds the current set; `agent_hooks_provision_startup` runs
  on every launch. New/changed events reach existing installs on next start.
- The status-machine refactor (docs/plans/status-machine.md) is staged: the pure reducer
  exists, the Stage-2 dispatcher (single home for hot state) does not. The new
  `subagentState` hot map follows the *current* pattern — **Stage 2 must absorb it**
  along with `lastOutputTimestamps` / `shellCommandRunning`.

## Design — shared reducer mechanics (agent-agnostic)

### `src/lib/statusReducer.ts`

- Extend `StatusState`:
  `activeSubagents: ReadonlyArray<{ id: string; startedAt: number }>`,
  `stopHeldForSubagents: boolean`. New constant `SUBAGENT_STALE_MS = 30 * 60_000`.
- New `StatusEvent` variants `{ kind: "subagentStarted" | "subagentStopped", agentId, now }`
  — these bypass `mapHookEvent` (they need an id, not a transition).
- Transition semantics:
  - `subagentStarted`: add/refresh `{id, startedAt}` (duplicate id refreshes); force
    `working` + `hookDriven` if not already working.
  - hook `"ready"` (turn-finished) with non-empty set → stay `working`, set
    `stopHeldForSubagents = true`; empty set → ready (current behavior, regression-guarded).
  - `subagentStopped`: remove id (unknown id → no-op, covers mid-session provisioning).
    Set drained while held and `working` → `ready`, clear flag. Never mutates
    `error`/`waiting` — only the set.
  - hook `"working"` (prompt submit): clear flag, **keep the set** (survivors must hold
    the next Stop too).
  - hook `"error"` (`StopFailure`): → error, clear flag. Stops afterwards only drain the
    set — never Error→Ready.
  - `sessionEnded` / `ptyExited` / ESC-cancel (`reduceKeystroke` esc branch,
    `clearActive`): clear set + flag.
  - `reduceTick` while `working` with a non-empty set: prune entries older than
    `SUBAGENT_STALE_MS` (drained + held → ready); otherwise **suppress** the
    `HOOK_IDLE_BACKSTOP_MS` ready-flip. Empty set → existing tick logic unchanged (still
    covers a dropped main `Stop`).

### `src/stores/ptyActivityStore.ts`

Reducer state is rebuilt per event via `hydrate()`, so the set lives in a hot map
(established pattern — per-Start/Stop churn must not re-render):

- New module map beside `lastOutputTimestamps` (~line 33):
  `subagentState: Map<ptyId, { subagents; stopHeld }>`.
- `hydrate()` (~132) reads it; `applyStatusEvent()` (~223) syncs back (delete when
  empty + false); the tick scanner (~499) bypasses `applyStatusEvent` → add the same
  sync there **before** its `after.state === before.state` early-continue (pruning
  changes the set without a state flip); `removePty` (~445) deletes the entry.
- New actions `subagentStarted(ptyId, id)` / `subagentStopped(ptyId, id)`, guarded like
  `applyHookEvent`.

### `src/lib/terminalManager.ts` (onHook, ~1068)

- Extend the payload parse: `agent_id` (tolerate `agentId`; Copilot: `agentName`;
  OpenCode: session id from `properties`).
- Intercept subagent events per agent **before** `mapHookEvent`: still call
  `setAgentPty`/`stampAgentOnPane` (a subagent hook proves agent mode), dispatch the
  store action, return. Missing/invalid id → debug-log, drop (never wedge on a
  malformed payload).

No changes to `computePtyDotStatus`, `AgentStatusIcon.tsx`, `LEGACY_STATE` maps,
`DotStatus`, or `agentTurnTracker`.

## Per-agent provisioning changes (`src-tauri/src/agent_hooks.rs`)

1. **Claude** — `merge_agent_events("claude")` (~214): add
   `("SubagentStart", None, true)`, `("SubagentStop", None, true)`.
2. **Qwen** — own arm replacing the shared `"gemini" | "qwen"` match: Claude's five
   events + the two subagent events (async like Claude's). Frontend:
   `HOOK_EVENT_MAP.qwen = HOOK_EVENT_MAP.claude`; delete the stale "identical to
   Gemini" comment. Older Gemini-style qwen ignores unknown event keys — no worse than
   today's silent breakage.
3. **Codex** — `codex_config()` (~317): add `"SubagentStart"`, `"SubagentStop"` to the
   event array; intercept the same PascalCase names for codex.
4. **Copilot** — `copilot_config()` (~352): add `("subagentStart", None)`,
   `("subagentStop", None)`; track by `agentName`.
5. **Gemini** — unchanged.
6. **OpenCode** — `opencode_plugin()` (~377): forward the payload —
   `body: JSON.stringify(event.properties ?? {})` instead of `"{}"`. Frontend routing:
   - `session.created`/`session.updated` with truthy `info.parentID` →
     `subagentStarted(sessionID)`; suppress `mapHookEvent` for those events.
   - `session.idle` / `session.error`: if `sessionID` is in the pane's Subagent set →
     `subagentStopped` (idle) / drop (the error belongs to the child); unknown → the
     main session's ready/error as today. Set membership compensates for `session.idle`
     lacking `parentID`, and fixes the pre-existing mid-turn "ready flash" when a child
     session goes idle.

## Tests

- **Rust** (`agent_hooks.rs` inline tests): new claude/qwen/codex/copilot event sets
  present after provisioning; re-provisioning an old-event-set settings.json upgrades
  without duplicates (incl. the qwen Gemini→Claude style swap); opencode plugin source
  contains `event.properties`.
- **`src/lib/__tests__/statusReducer.test.ts`** (table tests): Stop + empty set → ready
  (regression); two starts → Stop holds → stops drain → ready on last; unknown-id stop
  no-op; duplicate start refreshes `startedAt`; held tick suppresses the 30 s backstop,
  stale-prune → ready after `SUBAGENT_STALE_MS`; StopFailure while active → error and
  stays error when drained; prompt-submit keeps the set + clears the hold, next Stop
  re-holds; sessionEnded/ptyExited/ESC clear both; start from idle forces working.
- **`src/lib/__tests__/agentHookMap.test.ts`**:
  `mapHookEvent("claude"/"qwen", "SubagentStart"/"SubagentStop")` → null (documents the
  bypass); qwen map equals claude map.

## Docs

- Done alongside this plan: CONTEXT.md (`Turn` extension + prompt-submit cutoff, new
  `Subagent` entry), `docs/adr/0022-turn-extends-over-subagent-tails.md`.
- With the code: extend the per-agent mapping table in
  `docs/plans/agent-hooks-status-integration.md`.

## Verification (runtime > unit tests for status-machine work)

1. `pnpm test` + `cd src-tauri && cargo test`.
2. Back up `~/.claude/settings.json` and `~/.qwen/settings.json`; launch the app;
   confirm the new groups appear (and qwen's Gemini-style Abundio entries are gone),
   with no duplicates on relaunch.
3. Claude in a pane: "launch a background agent to explore X" — the pane stays amber
   after the main response renders, flips to the purple check only when the subagent
   finishes, and the Turn's duration in the Statistics overlay includes the tail. A
   plain prompt with no subagents → ready immediately (regression).
4. OpenCode: a task-tool prompt — no mid-turn ready flash when the child session
   finishes.
5. Qwen: any prompt — the status icon is now hook-driven at all (pre-existing fix).
