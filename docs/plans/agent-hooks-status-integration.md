# Agent Hooks → Status Indicator Integration

## Context

Abundio's `AgentStatusIcon` is currently driven by a **heuristic** in `ptyActivityStore.ts`: it
guesses whether an Agent is "active" by accumulating output bytes over sliding windows
(`terminalManager.ts:719-752`). It cannot tell *thinking* from *blocked-waiting-for-you*, and
lags real state by the 2s scan interval.

Every Agent we support except Aider now ships a **hook system** — lifecycle events that pipe a
JSON payload to a command on `stdin`. This plan registers Abundio's own hooks so the status
indicator reflects **ground truth** instead of a heuristic, and adds a new `Waiting` state the
heuristic can never detect: the Agent is blocked on the user (permission / input prompt).

See `CONTEXT.md` for the canonical terms **Agent hook** and **Waiting**, and
`docs/adr/0003-agent-hooks-provisioned-globally.md` for the provisioning decision.

### Hook event support (researched)

| Agent | Prompt submitted | Permission/waiting | Finished | Error |
|---|---|---|---|---|
| Claude Code | `UserPromptSubmit` | `PermissionRequest` | `Stop` | `StopFailure` |
| Copilot CLI | `userPromptSubmitted` | `permissionRequest` | `agentStop` | `errorOccurred` |
| Gemini / Qwen | `BeforeAgent` | `Notification` (permission matcher) | `AfterAgent` | *(none)* |
| Codex CLI | `UserPromptSubmit` | `PermissionRequest` | `Stop` | *(none)* |
| OpenCode | `message.updated` | `permission.asked` / `question.asked` | `session.idle` | `session.error` |
| Aider | — out of scope (no hook system) — | | | |

## Scope

- **In:** Claude Code, Copilot, Gemini, Qwen, Codex (command-hook relay); OpenCode (TS plugin).
- **Out:** Aider and any user-added custom Agents — they keep the existing byte-accumulation
  heuristic. No special-casing needed: `hookDriven` is only ever set by a real hook event,
  which only arrives for the five provisioned Agents; everything else falls through to the
  heuristic automatically.
- **Out:** answering permission prompts *from* Abundio's UI — observation only (see Decision 5).

## Architecture

```
Agent process (child of the PTY shell — inherits its env)
  └─ fires a hook → runs the abundio-hook relay script (a command hook)
       relay reads env: ABUNDIO_PTY_ID, ABUNDIO_HOOK_PORT, ABUNDIO_HOOK_TOKEN
       └─ if ABUNDIO_PTY_ID unset → print `{}`, exit 0 (no-op outside Abundio)
       └─ else: curl POST stdin → http://127.0.0.1:<port>/hook?event=&agent=&pty=
            └─ Rust hook_server.rs validates token
                 └─ emits Tauri event `agent-hook-<ptyId>`
                      └─ terminalManager pty.onHook listener
                           └─ agentHookMap maps (agent,event) → transition
                                └─ ptyActivityStore → DotStatus → AgentStatusIcon
```

**Why a relay (not a native `http` hook):** correlation. Hook payloads carry no Pane/PTY
identity. The PTY shell has `ABUNDIO_PTY_ID` in its env; the Agent and its hook processes
inherit it. Only a *command* hook can read that env var and attach it to the POST. The relay
is also the no-op guard for runs outside Abundio.

**Transport:** loopback HTTP via `tiny_http` on a dedicated thread (mirrors `pty_manager.rs`'s
OS-thread pattern; cross-platform, unlike Unix sockets). Bound to `127.0.0.1`, ephemeral port,
gated by a per-launch random token passed as the `ABUNDIO_HOOK_TOKEN` env var.

## Resolved decisions

1. **Global provisioning** of hook configs into each Agent's global config dir, behind an
   opt-in Settings toggle, clean removal of only Abundio's entries on disable. ADR-0003.
2. **Relay is a shell script** (`abundio-hook.sh` + `abundio-hook.ps1`) written into Abundio's
   existing shell-integration dir — not a compiled sidecar. No `externalBin`, no extra build
   target. Depends on `curl` (built into all three desktop OSes Abundio targets).
3. **Hooks are authoritative; safety nets stay.** A dropped event must never wedge the dot:
   the process-exit handler (`terminalManager.ts:781`) remains the hard backstop; for
   `hookDriven` PTYs the idle scanner keeps running but with a long ~30s threshold (vs the
   current 2s); `Waiting` is **never** auto-cleared on a timer.
4. **A hook event proves an Agent.** The `pty.onHook` listener calls `setAgentPty(ptyId,
   agentId)` if not already set (the relay passes `agent` in the POST). `hookDriven` is set on
   the first hook event and cleared by `clearAgentPty` (which fires on `command_end` and on a
   `SessionEnd`/`session.deleted` hook). Title-based detection stays as the fast/fallback path.
5. **The relay is a pure observer.** It always exits 0, outputs `{}` (valid empty JSON, no
   decision fields), and hooks are marked `async: true` wherever the Agent supports it. We
   never register a blocking-capable event we don't need (no `PreToolUse`/`PostToolUse`).
   Answering prompts from Abundio's UI is explicitly out of scope.
6. **`Waiting` notifications** fire when the pane is not visible to the user — window blurred
   *or* the pane is in a background tab/workspace. `ready`/`error` keep the existing
   blurred-only gate, unchanged.
7. **Provisioning marker:** for Copilot/Codex/OpenCode, Abundio writes a standalone file it
   solely owns (disable = delete it). For Claude and Gemini/Qwen (no separate hooks file),
   parse-merge-atomic-write into `settings.json`; identify Abundio's handlers by the
   relay-script path in their `command` (no custom keys — schema-safe); abort with a
   user-facing error if the file is unparseable (never clobber).
8. **`Waiting` clears** on the next authoritative hook event *or* a keystroke into that PTY
   (reuses `lastInputAt`) → `active`. OpenCode also uses `permission.replied`. No `PostToolUse`.
9. **Naming:** `PtyActivityState` gains `"waiting"`; `DotStatus` gains `"skyblue"`; the icon is
   lucide `HelpCircle` (sky-blue, pulsing); tooltip "Waiting for your input". Aggregation
   precedence: `red > skyblue > purple > amber > green > grey`.
10. **`Notification` is too broad to map flatly.** Drop it for Claude (use `PermissionRequest`).
    Keep it for Gemini/Qwen — their only permission signal — wired with a matcher scoped to the
    tool-permission notification type.
11. **Aider / custom Agents** — out of scope, heuristic fallback (see Scope).

## Implementation

### Rust backend (`src-tauri/src/`)

- **NEW `hook_server.rs`** — `HookServer` struct managed via `app.manage()`. On startup binds
  `tiny_http` to `127.0.0.1:0`; stores `port` + random `token`. A dedicated thread accepts
  POSTs to `/hook`, validates `token`, reads `event`/`agent`/`pty` query params + the body,
  emits `app.emit("agent-hook-{ptyId}", AgentHookEvent{...})`. Anything else → 403.
- **NEW `agent_hooks.rs`** — provisioning. `provision(enabled)` / unprovision per Decision 7.
  Writes the relay scripts into the shell-integration dir; marks `async: true` where supported;
  `PermissionRequest` matchers per Decision 10.
- **`shell_integration` dir** — also emit `abundio-hook.sh` and `abundio-hook.ps1` (the relay),
  alongside the existing `.zshrc`/`.bashrc`/`abundio_init.ps1`.
- **`pty_manager.rs` `spawn()`** (after line 152) — inject `ABUNDIO_PTY_ID=<pty_id>`,
  `ABUNDIO_HOOK_PORT`, `ABUNDIO_HOOK_TOKEN` from the managed `HookServer`
  (`app.state::<HookServer>()`).
- **`lib.rs` `setup()`** — start `HookServer`, `app.manage()` it; if the toggle is enabled,
  call `agent_hooks::provision()`.
- **`commands.rs`** — `agent_hooks_provision(enabled: bool)`, `agent_hooks_status()`.
- **`events.rs`** — add `AgentHookEvent { agent, event, payload }`.
- **`Cargo.toml`** — add `tiny_http`.

### Frontend (`src/`)

- **`lib/types.ts`** — `PtyActivityState` gains `"waiting"`; add `AgentHookEvent` type.
- **`lib/ipc.ts`** — `pty.onHook(ptyId, cb)` listening `agent-hook-${ptyId}`; `agentHooks`
  namespace (`provision`, `status`).
- **NEW `lib/agentHookMap.ts`** — pure `mapHookEvent(agentId, eventName)` →
  `"active" | "waiting" | "ready" | "error" | "clear" | null`. Pure + testable per CLAUDE.md's
  helper-extraction convention.
- **`stores/ptyActivityStore.ts`** — `DotStatus` gains `"skyblue"`; handle `"waiting"`; add a
  `hookDriven` flag per PTY and an `applyHookEvent` action; suppress the byte heuristic for
  `hookDriven` PTYs; long ~30s idle-scanner threshold for them; aggregation precedence per
  Decision 9; notification subscriber also fires on `"waiting"` per Decision 6.
- **`components/AgentStatusIcon.tsx`** — add the `"skyblue"` case: lucide `HelpCircle`,
  `text-sky-400`, glow + pulse.
- **`lib/terminalManager.ts`** — register `pty.onHook` in the `Promise.all` block (~line 635);
  route through `agentHookMap`; first hook event → `setAgentPty` + `hookDriven`; a keystroke
  into a `waiting` PTY → `active`.
- **CSS** — add an `agent-skyblue-pulse` keyframe alongside the existing `agent-*` keyframes.
- **`stores/settingsStore.ts`** — persisted `agentHooksEnabled` (default off, beta).
- **`components/SettingsPanel.tsx`** — "Agent status hooks (beta)" toggle → `agentHooks.provision`.

### Per-agent event mapping (`agentHookMap.ts`)

| transition | Claude | Copilot | Gemini/Qwen | Codex | OpenCode |
|---|---|---|---|---|---|
| active | UserPromptSubmit | userPromptSubmitted, preToolUse | BeforeAgent | UserPromptSubmit | message.part.delta, permission.replied, question.replied |
| waiting | PermissionRequest | permissionRequest | Notification (perm matcher) | PermissionRequest | permission.asked, question.asked |
| ready | Stop | agentStop | AfterAgent | Stop | session.idle |
| error | StopFailure | errorOccurred | — | — | session.error |
| clear | SessionEnd | sessionEnd | SessionEnd | — | session.deleted |

## Tests

- `lib/__tests__/agentHookMap.test.ts` — every (agent, event) pair maps correctly.
- `ptyActivityStore` tests — `"waiting"` entry/exit, keystroke clears `waiting`, aggregation
  precedence, heuristic suppression + 30s backstop when `hookDriven`.
- Rust `agent_hooks.rs` — provisioning idempotency, clean removal, abort-on-unparseable (temp
  config dir).
- Rust `hook_server.rs` — rejects requests with a missing/wrong token.

## Verification

1. `cd src-tauri && cargo test` and `pnpm test` pass.
2. `pnpm tauri dev`; enable the Settings toggle. Confirm hook entries in `~/.claude/settings.json`
   etc.; confirm unrelated keys are untouched.
3. Run `claude` in a pane: submit a prompt → **amber**; trigger a tool needing approval →
   **sky-blue question mark**; approve in the terminal → **amber**; on finish → **purple**.
4. Blur the window (or switch to another tab) during a permission prompt → desktop notification
   "Claude Code needs your input".
5. Repeat the prompt→finish cycle with `codex` and `gemini`.
6. `Ctrl-C` an agent mid-turn → dot resolves (process-exit backstop), not stuck amber.
7. Disable the toggle → Abundio's hook entries removed, unrelated config keys intact.

## Risks

- Provisioning edits global user config files — mitigated by opt-in toggle, relay-path marker,
  parse-merge-atomic-write, abort-on-unparseable, clean removal (ADR-0003, Decision 7).
- Gemini/Codex lack a clean error event — those Agents get partial coverage; the heuristic
  backstop covers the gaps.
- Copilot's `permissionRequest` fires for *every* tool (before the permission service), so an
  auto-approved tool briefly flashes the sky-blue dot until `preToolUse` pulls it back to
  active. Accepted — a sub-100ms flicker, no timer.
- Gemini runs hooks synchronously in its loop — the relay POSTs fire-and-forget with a tight
  timeout so it never adds latency.
