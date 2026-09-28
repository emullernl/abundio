# OpenCode Event Vocabulary Repair

## Context

Abundio's OpenCode integration is **not** deprecated in the way it first appears.
`agent_hooks.rs:517` provisions a genuine OpenCode *plugin* — `~/.config/opencode/
plugin/abundio.ts`, returning `{ event }` and forwarding the whole event bus to the
loopback status server. On the current release line (verified against opencode
1.18.21, `@opencode-ai/plugin` 1.4.8) the `event` hook is alive and unmarked, and the
singular `plugin/` directory is still supported alongside the newer `plugins/`.

The defect is narrower and worse: **four of the seven event names Abundio maps do not
exist**. Dumping the `Event` union from `@opencode-ai/sdk` 1.4.8:

| Mapped in `agentHookMap.ts:88-105` | Exists? | Reality |
|---|---|---|
| `message.part.delta` → active | ❌ | the event is `message.part.updated` |
| `permission.asked` → waiting | ❌ | the event is `permission.updated` |
| `permission.replied` → active | ✅ | |
| `question.asked` / `question.replied` | ❌ | no `question` namespace has ever existed |
| `session.idle` → ready | ✅ | |
| `session.error` → error | ✅ | but fires on user cancel too |
| `session.deleted` → clear | ✅ | |

So an OpenCode pane today reaches **Ready**, **Error** and session-clear, but has **no
working path to Working or Waiting**. `question.*` entered at #92 (24 May 2026);
`message.part.delta` was last touched at #163 (11 Aug 2026). The breakage was invisible
because a pane that silently never reaches Working reads as a slow agent, not a bug.

> **Superseded in part (2026-09-28):** the paragraph below was wrong about 2.x — it *has* a full lifecycle stream (`ctx.event.subscribe()`, `session.idle`, `session.execution.*`). 2.x support is now planned in `docs/plans/opencode-v2-status.md` on the same branch; this plan remains the 1.x half.

**OpenCode 2.0 is explicitly out of scope.** Its plugin API is a different shape
(`Plugin.define({ id, setup(ctx) })`, hooks registered on `ctx.session` / `ctx.tool` /
`ctx.permission`), the docs state plainly that "V1 plugins will not work in V2", and the
v2 contract is beta and still moving. Crucially the v2 hook set is transform/intercept
hooks, not a lifecycle firehose — there is no `session.idle` equivalent, which is what
drives Ready. Porting is therefore not a port at all; it is likely a move to the
opencode **server's** SSE event stream, and deserves its own investigation once v2
stabilises. Nothing in this plan should be shaped around it.

## Decisions (locked with the user via grilling)

| # | Decision | Rationale |
|---|----------|-----------|
| Scope | **Fix v1 only.** No v2 plugin, no version detection, no dual provisioning. | A live user-visible bug beats a beta API that will change under us. |
| Plugin | **`opencode_plugin()` is unchanged.** It already forwards every bus event with its `properties`. | The plugin was never the problem; the map was. No re-provisioning needed. |
| Working signal | `session.status` with `status.type === "busy"`. | Purpose-built turn-level signal that did not exist when #92 was written. Fires once per turn instead of once per token, which also makes turn start *observed* rather than inferred from generation — retiring the asymmetry the `TURN_START_EVENTS` comment apologises for. |
| `session.status` idle | → `null`. `session.idle` keeps sole ownership of **Ready**. | `session.idle` must stay in the pipeline regardless (it is OpenCode's Subagent-stop signal), so a second event racing to set Ready buys nothing and doubles the reasoning. |
| `session.status` retry | → `"resume"`. | Strict no-op unless **Waiting**; can never reset the working window or drop a Subagent-held Stop. |
| Waiting signal | `permission.updated` → waiting; `permission.replied` → active. | `Permission` carries only `time.created` — no status field — so the event *is* "a permission was asked". |
| `question.*` | **Deleted**, along with its comment. | Documents a flow OpenCode does not have; actively misleads the next reader into thinking two blocking mechanisms exist. Also remove the `question.replied` mention from the `TURN_START_EVENTS` doc comment and ADR-0027 line 38. |
| Cancel vs error | Branch on `error.name`: `MessageAbortedError` → `"idle"`, everything else → `"error"`. | Cancelling an OpenCode turn currently paints a red **Error** icon. Kimi's `Interrupt` and Grok's `Stop{reason:"cancelled"}` both map to Idle for this case — the user just acted in the pane, so nothing is unacknowledged, and an interrupt is not a clean finish. |
| Not split by ADR-0026 | Remaining errors all map to plain `"error"` (Turn failure), not `errorMidTurn`. | Unverified whether opencode keeps generating past a retryable `APIError`. If it does not, `errorMidTurn` leaves the pane Working with nothing to close it but the 30 s backstop. Revisit with evidence. |
| Discriminator plumbing | **Synthesise a compound event key** in the translator: `session.status:busy`, `session.error:MessageAbortedError`. | `mapHookEvent` already takes seven positional parameters, six of them Grok discriminators. Two more makes nine. A compound key keeps `HOOK_EVENT_MAP` and `TURN_START_EVENTS` plain string tables, adds no parameters, and makes turn start work for free because only the `:busy` key is listed. |
| Subagent leak | **A general session-ownership gate** for OpenCode, replacing the three-event allow-list. | Adding `session.status` widens an existing leak: a child session going idle would flash the pane Ready mid-turn — the exact defect ADR-0022 fixed for `session.idle`. `permission.replied` leaks this way *today*. This is the second patch over the same defect, so the root-cause fix is warranted rather than a third allow-list entry. |
| Exclusion, not identification | The gate asks "is this `sessionID` a known live Subagent?", not "is it the pane's own session?". | Positive identification needs the pane's own id, learned from the first `session.created` without a `parentID` — which a *resumed* session may never emit. Exclusion has no bootstrap gap. |
| Verification | **Live probe gates the design**, plus a permanent type-level CI guard. | Everything above is derived from `.d.ts` files, which is precisely how the four dead names got written. |

## The mapping

```ts
// agentHookMap.ts — declarative again, no opencode branches in mapHookEvent
opencode: {
  "session.status:busy":               "active",
  "session.status:retry":              "resume",
  "permission.updated":                "waiting",
  "permission.replied":                "active",
  "session.idle":                      "ready",
  "session.error:MessageAbortedError": "idle",
  "session.error":                     "error",   // fallback for other error.name
  "session.deleted":                   "clear",
}

TURN_START_EVENTS.opencode = new Set(["session.status:busy"]);
```

Note `ApiError`'s literal `name` field is **`"APIError"`**, not `"ApiError"` — do not
derive these strings from the TypeScript type names.

## Ordering constraint

`mapSubagentHookEvent` runs **before** `mapHookEvent` (`terminalManager.ts:~1190`) and
keys on raw names (`session.idle`, `session.error`, `session.deleted`). Compound-key
normalisation must therefore happen *after* the subagent check, or the subagent branch
must strip the suffix. Getting this backwards silently disables Subagent tracking.

## Probe protocol (run first — it gates the map)

A throwaway logging plugin at `~/.config/opencode/plugin/probe.ts`:

```ts
export const Probe = async () => ({
  event: async ({ event }) => {
    await Bun.write(
      "/tmp/opencode-events.ndjson",
      JSON.stringify({ t: Date.now(), ...event }) + "\n",
      { createPath: true },
    );
  },
});
```

Drive one scripted session in a real Abundio pane and answer, in order:

1. **Does `session.status` fire with `status.type === "busy"` at turn start, exactly
   once, before any message part?** — *This is the gate.* If no, fall back to
   `message.part.updated` → `"active"` and verify it does **not** fire after
   `session.idle` (the resurrection hazard flagged at `agentHookMap.ts:89`).
   Note that opencode issue #12860 concerns the `GET /session/status` HTTP endpoint,
   which is a different code path from the bus event — it may not apply here at all.
2. **Does `permission.updated` fire for permissions the config auto-*allows*?** Set a
   rule to `"allow"` and run a matching tool. A yes is the false-Waiting trap that
   forced matchers onto both Grok and Copilot, and would need the same treatment.
3. **Do child sessions emit `session.status`?** Spawn a subagent. Decides whether the
   ownership gate is load-bearing or merely defensive.
4. **Does Esc mid-turn produce `session.error` with `error.name ===
   "MessageAbortedError"`?**
5. **Does a resumed session (`opencode --continue`) emit `session.created`?** Confirms
   the bootstrap-gap reasoning behind choosing exclusion over identification.
6. Confirm `session.idle`, `session.deleted`, `permission.replied`, and
   `session.created` with `parentID` all still fire as assumed.

Capture the resulting log into this document before writing the map.

## Regression guard (permanent)

Add `@opencode-ai/sdk` as a devDependency and a Vitest case asserting that every key in
`HOOK_EVENT_MAP.opencode`, split on `:`, has a prefix present in the SDK's `Event`
union. All four dead names would have failed CI. This is the structural answer to "how
did this survive three months".

## Commits (one branch, ordered)

1. `test:` add the `@opencode-ai/sdk` devDependency and the event-name guard — **red**,
   proving it catches the four dead names.
2. `refactor:` compound event-key normalisation for OpenCode in the translator, after
   the subagent check.
3. `fix:` correct the OpenCode event map (`session.status:busy`, `permission.updated`,
   drop `question.*`) — turns the guard green.
4. `fix:` `MessageAbortedError` → Idle, so cancelling a turn stops painting red.
5. `fix:` generalise OpenCode subagent filtering to a session-ownership gate; closes the
   `permission.replied` leak.
6. `docs:` CONTEXT.md ambiguity entry, ADR-0022 amendment, this plan updated with the
   captured probe log.

## Documentation

- **CONTEXT.md** — Flagged ambiguities entry recording that OpenCode is the only Agent
  whose hooks are session-scoped rather than PTY-scoped, and the only one with no
  prompt-submitted hook. *(Written.)*
- **ADR-0022** — amend: the child-session discrimination becomes an ownership gate over
  all events rather than a three-event allow-list, with the bootstrap-gap reason for
  rejecting positive own-session identification. Not a new ADR — the decision being
  revised is ADR-0022's own.
- **ADR-0027** — remove the `question.replied` mention at line 38.
