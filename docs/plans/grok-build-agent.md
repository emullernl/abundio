# Add Grok Build (xAI) as a built-in supported agent with hook-driven status

## Context

Abundio supports 8 built-in AI coding CLI agents with hook-driven pane status. xAI's **Grok Build** (CLI command `grok`, launched May 2026, open-sourced July 2026 at github.com/xai-org/grok-build) should become the 9th. The user has `grok` installed locally (`~/.local/bin/grok`, config home `~/.grok/`), so live end-to-end verification is possible.

**Key finding** (verified against the bundled official docs at `~/.grok/docs/user-guide/10-hooks.md`): Grok Build's hook system is deliberately Claude-Code-compatible. Hooks are standalone JSON files in `~/.grok/hooks/*.json` using the Claude matcher-group schema, and **global-scope hook files are always trusted** (no trust gate — that only applies to project-scope hooks). This makes Grok a clean fit for the existing **`Ownership::Owned` + `ConfigFormat::Json`** path (like codex/copilot): Abundio owns `~/.grok/hooks/abundio.json` outright. No TOML merging, no new `HookTransition`, no `statusReducer`/`ptyActivityStore` changes.

Model commit: 94178bb (Kimi Code addition) — but simpler, since Grok reuses existing formats.

## Grok Build facts (confirmed from bundled docs)

- Command: `grok`. Config home `~/.grok/` (hooks dir `~/.grok/hooks/`, created on demand — `write_atomic` creates parents).
- Hook file schema: `{"hooks": {"<Event>": [{"hooks": [{"type":"command","command":"..."}]}]}}` — matcher optional; lifecycle events (SessionStart/SessionEnd/Stop/UserPromptSubmit) *reject* a matcher, so omit it everywhere (`make_group(None, ...)` already does).
- Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied, Stop (fires on completed/cancelled/error turns), StopFailure (API error), Notification, SubagentStart, SubagentStop (+alias SubagentEnd), PreCompact, PostCompact, SessionEnd.
- Hook stdin: camelCase JSON (`hookEventName` in snake_case, `sessionId`, `cwd`, `toolName`, `toolInput`, `toolUseId`…). Irrelevant to event routing — Abundio bakes the event name into the relay command per provisioned event (`command_str`).
- Failures fail-open; relay always exits 0 → Grok is never affected. Default hook timeout 5s (relay curls with `-m 2`, fine).
- Warning to record in docs: the community npm "grok-cli" packages are unrelated to Grok Build; detection is `grok` on $PATH only.
- Open question to close empirically during implementation (Phase 0): the subagent-id field name in SubagentStart/SubagentStop payloads. Existing fallback chain in `mapSubagentHookEvent` already reads `agent_id ?? agentId`, so likely zero code needed.

## Phase 0 — Empirical checks (with the local grok install)

Grilled decisions (2026-07-17): all three probes below were explicitly chosen over the simpler always-on fallbacks; each has an agreed fallback if the probe is inconclusive.

1. **Subagent id field**: register a debug hook (`cat > /tmp/grok-hook-$GROK_HOOK_EVENT.json`) for SubagentStart/SubagentStop, run a subagent-spawning prompt, inspect payload. If the id field isn't `agent_id`/`agentId`, extend the fallback chain in `mapSubagentHookEvent` (src/lib/agentHookMap.ts:189). (SubagentStart/SubagentStop confirmed to exist in the bundled docs, `~/.grok/docs/user-guide/10-hooks.md`; `SubagentEnd` is an accepted alias for SubagentStop.)
2. **Stop payload on a cancelled turn** (DECIDED: probe + branch): Grok's `Stop` fires on completed, cancelled, AND errored turns — but CONTEXT.md defines Ready as a *clean* finish, and Kimi maps user-cancel to `idle`. Capture a cancelled-turn Stop payload; if it carries a reason/outcome discriminator, add a grok branch in `mapHookEvent` (copilot-preToolUse-style, terminalManager already parses the full payload — pass the field through like `toolName`): cancelled→`idle`, completed→`ready`. Fallback if indistinguishable: plain `Stop→ready` (brief Ready-on-cancel, cleared by the focused user's acknowledgement).
3. **Notification types** (DECIDED: probe + matcher-scope): Grok's `matcher` on Notification tests the *notification type* — the same discriminator Copilot uses (`matcher: "permission_prompt"`, ADR-0015). Capture Notification payloads on a permission prompt / grep github.com/xai-org/grok-build for the type strings. If a permission-prompt type exists, provision the Notification hook matcher-scoped so only genuine prompts map to `waiting`. Fallback: unmatched Notification→waiting (Gemini-style accepted limitation).
4. **Single vs double ESC to cancel**: check live; default to double-ESC (no `escPressesToCancelAgent` change) unless single-ESC confirmed.

## Phase 1 — Backend: `src-tauri/src/agent_hooks.rs`

1. `GROK_EVENTS` const (near `KIMI_EVENTS`, ~line 565). Subscribe only status-relevant events — PreToolUse/PostToolUse/PostToolUseFailure/PreCompact/PostCompact deliberately absent (per-tool noise; no map value — matches claude/qwen/kimi precedent):
   ```rust
   const GROK_EVENTS: &[&str] = &[
       "UserPromptSubmit", "Notification", "PermissionDenied",
       "Stop", "StopFailure", "SubagentStart", "SubagentStop", "SessionEnd",
   ];
   ```
2. Append `"grok"` to `SUPPORTED_AGENTS` (line 552).
3. Descriptor arm in `agent_descriptor()` (~line 687):
   ```rust
   "grok" => Some(AgentDescriptor {
       dir_rel: PathBuf::from(".grok"),                       // no-litter gate: "is grok installed"
       config_rel: [".grok", "hooks", "abundio.json"].iter().collect(),
       ownership: Ownership::Owned,
       format: ConfigFormat::Json,
       events: GROK_EVENTS.iter().map(|s| s.to_string()).collect(),
   }),
   ```
   (Grok's home is relocatable via `$GROK_HOME`; like every other descriptor, only the default location is supported.)
4. `grok_config(relay)` builder mirroring `codex_config` (line 425) — Claude-compatible schema, so `command_str` + `make_group(None, cmd, false)` produce the right shape; one matcher-less group per `GROK_EVENTS` entry, `to_string_pretty`.
5. Wire `"grok" => grok_config(...)` into `owned_content()` (line 694).

Nothing else changes: Owned-branch `config_state` (content equality → self-heal), `ensure_agent_hooks`, `provision`, and `agent_registry.rs` all work generically.

## Phase 2 — Frontend

1. `src/lib/agents.ts` — append to `BUILTIN_AGENTS`:
   `{ id: "grok", name: "Grok Build", command: "grok", builtin: true, enabled: true }`. No `escPressesToCancelAgent` change (pending Phase 0.2).
2. `src/lib/agentHookMap.ts` — add `HOOK_EVENT_MAP.grok` (after kimi, ~line 99) with rationale comment:
   ```ts
   HOOK_EVENT_MAP.grok = {
       UserPromptSubmit: "active",
       Notification: "waiting",     // matcher-scoped to permission-prompt notification type if Phase 0.3 pins it down; else unmatched (Gemini-style)
       PermissionDenied: "active",  // fires AFTER the deny — user/policy just acted, turn continues; Stop/StopFailure corrects if the turn ends
       Stop: "ready",               // + per Phase 0.2: if the payload distinguishes a cancelled turn, a mapHookEvent grok branch maps cancelled→"idle" (CONTEXT.md: Ready = clean finish; Kimi precedent)
       StopFailure: "error",
       SessionEnd: "clear",
   };
   ```
3. Subagent branch: add `"grok"` to the claude/qwen/codex/kimi condition in `mapSubagentHookEvent` (~line 181) and its doc comment; the `agent_id ?? agentId` fallback likely already covers the payload (Phase 0.1 confirms).
4. `src/lib/agentIcons.tsx` + `src/assets/agent-icons/grok.svg` — DECIDED: use the official product mark from `grok.com/images/favicon.svg` (already downloaded to scratchpad and verified): white Grok glyph on a near-black `#050505` rounded tile, 512×512. Strip the decorative Figma-export `foreignObject` blur layer (won't render in `<img>` anyway). Because the dark tile is part of the asset it is theme-safe on BOTH light and dark — no codex/kimi invisible-on-light caveat. `brandImg(...)`, new `case "grok"`, attribution comment citing grok.com/images/favicon.svg. (x.ai/brand is 403; x.ai/favicon.ico is the xAI company mark, not the product mark — rejected.)
5. `src/lib/demo/fixtures.ts` — add `"grok"` to `installedAgentCommands` (~line 1278) and an `agentHookStatuses` entry (`configPath: "~/.grok/hooks/abundio.json"`, `ownership: "owned"`, the 8 events, `state: "registered"`).

## Phase 3 — Tests

- `src/lib/__tests__/agents.test.ts`: `"grok"` in builtin commands; `escPressesToCancelAgent("grok") === 2`.
- `src/lib/__tests__/agentHookMap.test.ts`: grok event→transition table incl. `PermissionDenied → "active"` and null for unsubscribed events (PreToolUse/PostToolUse/PreCompact); add `"grok"` to the subagent-classification loop (~line 120).
- `agent_hooks.rs` `#[cfg(test)]`:
  - `grok_config_registers_expected_events` — parse builder output; all `GROK_EVENTS` present, no matcher key, commands contain the event name + relay path (pattern: `codex_and_copilot_configs_register_subagent_events`, line 1170).
  - Owned self-heal: provision into temp home with `.grok`, strip an event, assert not-registered → re-provision heals (pattern: `stale_owned_content_reads_not_registered`, line 1136).
  - No-litter: provisioning with no `~/.grok` dir writes nothing.
- No `statusReducer.test.ts` changes (no new transitions).

## Phase 4 — Docs / meta

- `README.md` supported-agents table: Grok Build row.
- `CONTEXT.md`: Agent list, Hook-provisioning terms (Owned/JSON, global hooks dir always trusted), Subagent claude-family branch.
- `CLAUDE.md`: agent roster mentions (project description + `agents.ts`/hook lines).
- `docs/plans/grok-build-agent.md`: persist this plan (per repo convention), including the npm-grok-cli-is-unrelated warning and Phase-0 findings.

## Phase 5 — Verification (end to end)

1. `cd src-tauri && cargo test` and `pnpm test`; `pnpm check`.
2. Demo mode (`pnpm demo`): Settings → Agents shows Grok Build with icon, installed, owned footprint `~/.grok/hooks/abundio.json` + 8 events.
3. Live app: enable Status Hooks → `~/.grok/hooks/abundio.json` appears with the expected content. Launch `grok` in a pane:
   - submit prompt → Working (`UserPromptSubmit`)
   - permission prompt → Waiting (`Notification`); deny → Working (`PermissionDenied`)
   - turn finishes → Ready (`Stop`)
   - subagent-spawning prompt → pane holds Working past `Stop` until `SubagentStop` (also closes Phase 0.1 via hook-server log)
4. `grok` outside Abundio: hooks fire, relay no-ops (no `ABUNDIO_PTY_ID`), grok unaffected.
5. Toggle hooks off → `abundio.json` deleted, rest of `~/.grok/` untouched.

## Phase 0 findings (resolved 2026-07-17, against grok-build source + local install)

1. **Subagent id field**: `subagentId` (camelCase; `xai-grok-hooks/src/event.rs` — payload also carries `subagentType` and optional `description`). The `mapSubagentHookEvent` fallback chain was extended to `agent_id ?? agentId ?? subagentId`.
2. **Stop payload**: `reason: "end_turn" | "cancelled" | "error"` (`acp_session_impl/turn.rs`; "cancelled" also covers max-turns). Branched in `mapHookEvent`: end_turn → ready, cancelled → idle, error → error. The error case is load-bearing: Grok fires `Stop` AFTER `StopFailure` on errored turns, so an unconditional "ready" would overwrite the Error icon.
3. **Notification types**: first-party blocking types are `permission_prompt` (tool permission + plan approval) and `elicitation_dialog` (user question); plugins can dispatch arbitrary types. The Notification hook is provisioned matcher-scoped to `permission_prompt|elicitation_dialog` (Copilot-style).
4. **ESC**: never cancels a Grok turn (Ctrl+C does; bundled keyboard-shortcuts guide) — no `escPressesToCancelAgent` entry; `Stop{cancelled}` is the authoritative cancel signal.
5. **Trust gate**: global `~/.grok/hooks/*.json` files are ALWAYS trusted (bundled hooks guide); the folder-trust gate applies only to project-scope hooks. No Settings warning needed.
