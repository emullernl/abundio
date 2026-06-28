# Status Machine — Deepening the PTY Status State Machine

## Context

Abundio derives a **PTY**'s status — the **Status indicator** dot: Idle / Working /
Waiting / Ready / Error — from agent lifecycle hooks, shell-integration markers, an
output-byte heuristic, user keystrokes, and a periodic idle scan. Today there is **no
module** that owns this. The state machine is an emergent property of code scattered
across `ptyActivityStore.ts`, `terminalManager.ts`, `agentHookMap.ts`, and
`activityGate.ts`:

- A PTY's "state" is a tuple smeared across **three storage locations**: Zustand
  (`activities[ptyId]`), out-of-band module Maps (`ptyActivityStore.ts:28,32` —
  `lastOutputTimestamps`, `shellCommandRunning`, kept outside Zustand *purely* to avoid
  re-renders on every output chunk), and `ManagedTerminal` locals (`bytesSinceIdle`,
  `thresholdHitTimes`, `lastInputAt`).
- The transition **decisions** live in `terminalManager`'s IPC handlers
  (`:824–1075`) — which store method to call on a keystroke, a `command_end`, a hook,
  an exit. `terminalManager` is making state-machine decisions, not just translating IPC.
- The activity-byte heuristic is **duplicated** foreground (`:997–1034`) vs background
  (`:339–370`).
- Telemetry and notifications compete on ordering, defused only by hand-ordered
  imperative calls (`:1060–1063` — "set state BEFORE setPtyStatus", "finalize the Turn
  BEFORE the state flips").

The interface — which *is* the test surface — is spread across six files; the core
transitions (the ADR-0015 Waiting guard, the ADR-0009 agent/shell asymmetry, the idle
backstop, ESC cancel) are testable only through the live app.

This plan extracts one **Status machine**: a pure **status reducer** behind a
**dispatcher**, with two narrow seams — a **Status event** input vocabulary and an
enriched **Status transition** output stream — feeding three consumers (UI,
notifications, **Turn** telemetry).

It does **not** contradict ADR-0009 / 0015 / 0018 / 0020. It concentrates the behaviour
those ADRs specify into one testable place.

## Decisions (locked with the user via grilling)

| # | Decision | Rationale |
|---|----------|-----------|
| Scope | **L-layered.** The machine owns the FSM, **detection mode**, the activity heuristic, timing, **and** Tab/Workspace aggregation; it feeds **Turn** telemetry + notifications via a shared output seam. | Deletion test pays off most here; dissolves the subscriber-ordering races *by construction*, not by comment. |
| Carve | **Two seams, not one flat bus**: an **input** Status-event vocabulary (reducer + telemetry read) and an **output** Status-transition stream (UI + notifications + telemetry read). | A single bus would widen to telemetry's needs and go shallow. Two narrow seams stay deep. |
| Core | **Pure reducer, effectful subscribers.** `(state, Status event) → state`, no clock — time arrives via `Tick`. Telemetry + notifications are effectful adapters at the seams. | Makes every transition a deterministic table test; isolates all side effects. |
| Telemetry source | Telemetry consumes the **enriched output** (`StatusChange{prev,next,cause}`), **not** the input. | The idle backstop (`Working→Ready` on a dropped Stop, `ptyActivityStore.ts:462–471`) is a turn boundary with **no input event** behind it — only the output stream catches reducer-derived transitions. `cause` supplies the end-reason fidelity the inline side channels give today. |
| State home | The **dispatcher** owns **all** per-PTY status state (hot + cold); React re-renders are gated by a diff of the dot-relevant slice. | Resolves the three-location split instead of inheriting it. |
| Shell signal | One `ShellCommandEnded{exit}` input event; the translator emits it from whichever source fired. | OSC markers (integrated shells) and process-monitor `CommandFinished` (`process_monitor.rs:5`, `pty_manager.rs:589` — `ShellType::Other` only) are **mutually exclusive by shell type**, not redundant. |
| Permission count | **Accuracy upgrade, same meaning.** `permissionRequestsCount` stays "every blocked-on-you pause" but counted **exactly** from `cause`, replacing today's approximate waiting-entry tally (`agentTurnTracker.ts:173–177`). | User choice. The *only* intended behaviour change in the whole refactor; isolated to Stage 4. |
| Names | `active`→**Working**, etc. The reducer's state type adopts the canonical glossary names. | Resolves the deferred `active`→`working` code rename (CONTEXT.md flagged ambiguity). |

---

## Design

### Input seam — the Status event vocabulary

A tight discriminated union defined by the **agent/shell/user domain**, not by any
consumer. Each carries a timestamp; the reducer never reads a clock.

| Status event | Emitted by (translator source) |
|---|---|
| `PromptSubmitted` | agent hook (`UserPromptSubmit`/`userPromptSubmitted`/`BeforeAgent`/`message.part.delta`/…) |
| `PermissionRequested` | agent hook (`PermissionRequest`/`notification`/`permission.asked`/`question.asked`/Copilot `preToolUse` for `exit_plan_mode`,`ask_user`) |
| `TurnStopped{ ok \| fail }` | agent hook (`Stop`/`StopFailure`/`AfterAgent`/`session.idle`/`session.error`) |
| `SessionEnded` | agent hook (`SessionEnd`/`session.deleted`) — drops agent mode |
| `ShellCommandStarted` | OSC `command_start` **or** process-monitor `CommandStarted` |
| `ShellCommandEnded{ exit }` | OSC `command_end` **or** process-monitor `CommandFinished` **or** PTY exit |
| `OutputBurst` | the byte-accumulation heuristic crossing its threshold (foreground or background) |
| `Keystroke{ kind: answer \| dismiss \| cancel \| other }` | `term.onData`, after focus/report-sequence filtering |
| `PtyExited{ code }` | `pty.onStatus` exited |
| `Tick{ now }` | the global idle scanner |

`mapHookEvent` (agentHookMap.ts) and `classifyShellExit` (activityGate.ts) survive as
**translator helpers** that turn raw hook payloads / exit codes into these events —
they no longer reach into the store.

### Output seam — the Status transition

```
StatusChange {
  ptyId
  prev, next   // full status tuple: { state, detectionMode, sessionId }
  cause        // the Status event that drove it, or `TickBackstop`
}
```

Emitted whenever the tuple changes — including **mode/session-only** changes (e.g.
`SessionEnded` flips agent→shell with no dot change). Consumers filter:

- **UI** reads `next.state` → dot colour (`computePtyDotStatus`).
- **Notifications** read `next.state ∈ {Ready, Error, Waiting}` + pane visibility / blur.
- **Turn telemetry** reads `cause` + `next` + the cause's payload.

Carrying `cause` in-band is what kills the ordering races at `:1060–1063`:
`cause: PtyExited{code}` and `cause: SessionEnded` arrive in order, so telemetry no
longer needs the inline `onPtyExit`/`onSessionEnd` side channels.

### Module shape

```
raw IPC (output bytes, hooks, status, keystrokes)        idle scanner
        │                                                     │
        ▼  translator (per-PTY, in terminalManager)           ▼ Tick
        └──────────────► Status events ──────────────────────►┘
                                  │
                                  ▼
                          dispatcher  ── owns Map<ptyId, status tuple + hot fields>
                                  │     runs the pure reducer; diffs dot-slice
                    ┌─────────────┼──────────────────────┐
                    ▼ (project)   ▼ (emit)               ▼ (emit)
              Zustand dot-slice   StatusChange ───────────┤
                    │                    │                │
                    ▼                    ▼                ▼
                   UI            notifications      Turn telemetry
```

- **Reducer** — pure, per-PTY, the only place transition logic lives. Includes the
  ADR-0015 Waiting guard, the ADR-0009 agent/shell asymmetry, ESC single/double cancel,
  shell-vs-agent exit, and the `Tick` backstop.
- **Dispatcher** — runtime home for *all* per-PTY status state (replaces both
  `activities[ptyId]` **and** the out-of-band Maps **and** the `ManagedTerminal`
  heuristic locals). Runs the reducer, writes only the dot-slice into Zustand (preserving
  the no-re-render-on-hot-fields property), emits `StatusChange`.
- **Aggregation** — `computeTabDotStatus` / `computeWorkspaceDotStatus` stay pure
  functions taking layouts as input (they do **not** reach into `workspaceStore`).

---

## Staging

Every step before the last is **behaviour-preserving**; the last step is where recorded
behaviour intentionally changes. That ordering is the whole argument.

### Stage 1 — Extract the pure reducer + input vocabulary, under characterization tests. *(Zero runtime risk.)*
Build the reducer + Status-event union wired to nothing. Write table tests pinning
**every** current behaviour as documented: ADR-0009 asymmetry, ADR-0015
Waiting-not-stomped, ESC single/double cancel, the 30s backstop, shell-vs-agent exit
classification. The test suite *is* the deliverable and the safety net for all later
stages.

### Stage 2 — Wire it in behind the dispatcher; keep the Zustand shape identical. *(Behaviour-preserving.)*
`terminalManager` stops calling store methods and emits Status events to the dispatcher.
The dispatcher runs the reducer and projects the dot-slice into the **existing**
`activities[ptyId]` shape, so the current notification and telemetry subscribers keep
working untouched. The out-of-band Maps and the foreground/background heuristic
duplication collapse here (one translator emits `OutputBurst`).

### Stage 3 — Migrate notifications onto the output seam. *(Low risk.)*
Point the notification logic at `StatusChange` (read `next` + visibility); delete the
ad-hoc Zustand-diffing subscriber at `ptyActivityStore.ts:492`. Notifications are
best-effort and idempotent — easy to verify by eye.

### Stage 4 — Migrate telemetry onto the output seam. **LAST.**
Make `subscribeStatusChange` the primary telemetry driver. The engine
(`noteState`/`onPtyExit`/`onSessionEnd`/`finalizeAllOpenTurns`) is left unchanged, so
its tests pass verbatim. `cause: recordExitSuccess | recordError` *is* the pty-exit
signal for an agent, so the handler finalizes `pty_exit` in-band — the inline
`trackPtyExit` calls (`:375`, `:1059`) and the hand-ordering they required are deleted,
dissolving the race. A small `store.subscribe` backstop stays for the one signal that
isn't a status transition: a PTY removed from the store (teardown without a pty-exit).

**Two faithfulness nuances found in implementation:**
- **Session-end stays an explicit `trackSessionEnd`** in the hook-clear path, not
  cause-driven. The same `clearAgentPty` also fires on a shell `command_end` that merely
  drops agent mode — and that must **not** finalize a Turn — yet both emit an identical
  `cause: sessionEnded`, so the seam can't tell them apart. Keeping the explicit call
  preserves today's hook-clear-only finalize exactly.
- **The permission count is unchanged, not "made exact."** Under decision (a) the metric
  means "every blocked-on-you pause," which `noteState` already counts once per Waiting
  entry — and the new one-StatusChange-per-transition driver counts identically. So
  Stage 4 ends up behaviour-preserving too; its value is architectural (telemetry on the
  seam, race dissolved), not a metric change.

**Why telemetry is last, specifically:**
- It holds the most state (open Turns, sessions, git snapshots, contamination) and the
  only async effects (git fetch, DB write).
- Its current correctness *depends on the very races being removed*. By the time it
  migrates, the in-band `cause` it needs is built and proven by Stages 2–3.

---

## Test strategy

The reducer is the new test surface: pure `(state, event) → state` table tests, no
xterm, no IPC, no fake timers (time is the `Tick` payload). Each load-bearing comment in
today's code becomes a named case:

- Waiting not stomped by the permission prompt's own render output (ADR-0015).
- `markIdle` refuses to cancel a Working agent / a running shell command.
- ESC dismiss → Idle; Enter/digit answer → Working; ESC cancel single vs double.
- Backstop: `Working` + `Tick` past `HOOK_IDLE_BACKSTOP_MS` → Ready (agent) / Idle (shell).
- Shell exit classification incl. user-stop codes 130/143.

Aggregation tests (already pure) and telemetry tests (now drivable from a synthetic
`StatusChange` stream rather than a faked Zustand store) both improve.

## Behaviour preservation

As implemented, the whole refactor is behaviour-preserving. The permission count we
planned to "make exact" turned out, under decision (a) ("every blocked-on-you pause"), to
already be exact — `noteState` counts once per Waiting entry, and the new driver fires
once per transition, so the number is identical. Everything else is a pure relocation of
transition logic into the reducer (the legacy `PtyActivityEntry` shape, the out-of-band
hot maps, and all the pure aggregation/selector functions are untouched), guarded by the
Stage-1 characterization suite plus the unchanged 1264-line `ptyActivityStore.test.ts`.
The `active`→`working` rename lives only inside the reducer; the store still projects the
legacy `"active"` string. **In-app verification remains worthwhile** for the parts no unit
test covers: the dot colours under live agent/shell activity, OS notifications while
blurred, and Turn rows in the Statistics overlay.

## Vocabulary (added to CONTEXT.md)

**Status event** (input), **Status transition** (output), **Status machine** (the
module). Distinct from the existing **Status indicator** (the dot — the *view*). The
reducer's state type adopts the canonical **Working / Waiting / Ready / Idle / Error**,
resolving the deferred `active`→`working` flagged ambiguity.

## Pre-flight

No DB migration, no schema change — pure frontend refactor (the `agent_turn` table is
untouched; only *how* a row's fields are sourced changes, in Stage 4). No DB backup
required. Persist this plan, then start at Stage 1.
