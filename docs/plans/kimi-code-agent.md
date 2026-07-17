# Kimi Code as a Built-in Agent

## Context

Moonshot AI's **Kimi Code CLI** (binary `kimi`, npm `@moonshot-ai/kimi-code`) is a
Claude-Code-style TypeScript CLI with a Beta lifecycle-hooks system. It becomes a
first-class built-in **Agent** (CONTEXT.md): PATH-detected, brand icon, and
hook-driven **Status indicator** via **Hook provisioning** (ADR-0003).

Kimi facts (official docs, mid-2026):

- Config home `~/.kimi-code/` (relocatable via `KIMI_CODE_HOME` — unhonored,
  consistent with `CLAUDE_CONFIG_DIR` being unhonored for Claude).
- Hooks live in the user-owned `~/.kimi-code/config.toml` as `[[hooks]]`
  array-of-tables with **only** `event`, `command`, optional `matcher`, optional
  `timeout` — **any extra key fails the whole config load** (strict loader). So no
  marker field is possible; Abundio's entries are identified by the relay path
  inside `command`, the same convention as the JSON agents.
- Events use Claude's vocabulary plus extras: `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionResult`,
  `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `Stop`,
  `StopFailure`, `Interrupt`, `PreCompact`, `PostCompact`, `Notification`.
  Payload arrives as JSON on stdin (`hook_event_name`, `session_id`, `cwd`,
  snake_case extras like `agent_id`) — exactly what the relay script forwards via
  `curl --data-binary @-`.

The existing pipeline (relay → loopback `hook_server.rs` → `agent-hook-{ptyId}` →
`terminalManager` → `agentHookMap` → status machine) is agent-agnostic past the
mapping layer. The one substantial new piece: Kimi's co-owned config is **TOML**,
while `Ownership::Merged` provisioning (`provision_merge_settings`) is JSON-only.

## Decisions (locked with the user via grilling)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Icon | **White icon SVG** from Moonshot's official brand kit (moonshotai.github.io/Branding-Guide/; the brand is monochrome-only) | Matches the codex.svg precedent (`fill="#fff"`, dark-UI optimized); invisible-on-light is the accepted shared limitation. |
| Event set | **Minimal 9**: UserPromptSubmit, PermissionRequest, PermissionResult, Stop, StopFailure, Interrupt, SubagentStart, SubagentStop, SessionEnd | Claude's set plus Kimi's extras that fix real gaps. PreToolUse/PostToolUse are per-tool-call noise; Notification is redundant (Gemini only uses it for want of PermissionRequest). |
| Interrupt mapping | **New `"idle"` HookTransition**; `Interrupt → idle`, dropping the Subagent set | `Interrupt → ready` would flash a false purple Ready right after the user cancels — violating CONTEXT.md's **Ready** (clean finish, unacknowledged). Mirrors the reducer's ESC `clearActive` path. |
| ESC presses | **No `escPressesToCancelAgent` change** (kimi keeps the default 2) | The Interrupt hook is the authoritative cancel signal; the keystroke heuristic is a mere fallback that can no longer strand or lie about status. |
| TOML editing | `toml_edit` (already in Cargo.lock transitively) with format-preserving surgical edits; **no backup file** | The user's config.toml likely carries comments a serde rewrite would destroy. Guards: only-allowed-keys unit test, round-trip parse, `write_atomic`, strip-first idempotent merge. A `.bak` would violate ADR-0003's no-litter spirit. |
| Demo mode | Settings **footprint only** (installedAgentCommands + agentHookStatuses); no scripted pane/transcript | Smallest surface that keeps LaunchPicker and Settings → Agents truthful in demo mode. |
| Docs | CONTEXT.md term updates (Agent list, Hook provisioning file list, Subagent hooks); **no new ADR** | The TOML merge is a reversible extension of ADR-0003's existing decision. |

## Implementation

### Frontend

- `src/lib/agents.ts` — append `{ id: "kimi", name: "Kimi Code", command: "kimi", builtin: true, enabled: true }` to `BUILTIN_AGENTS`. `mergeAgentsWithBuiltins` auto-surfaces it for existing users; `agent_registry.rs` needs no change (frontend owns the command list).
- `src/lib/agentIcons.tsx` + `src/assets/agent-icons/kimi.svg` — white brand mark, `brandImg` pattern, attribution comment.
- `src/lib/agentHookMap.ts` — new `kimi` block:
  `UserPromptSubmit→active, PermissionRequest→waiting, PermissionResult→active, Stop→ready, StopFailure→error, Interrupt→idle, SessionEnd→clear`.
  Widen the claude/qwen/codex branch of `mapSubagentHookEvent` with `"kimi"`.
- Status machine — extend `HookTransition` with `"idle"`: in `statusReducer.applyHook`, `"idle"` transitions to Idle **and** drops `activeSubagents` / `stopHeldForSubagents` (mirrors ESC clearActive); `ptyActivityStore.applyHookEvent` passes it through.

### Backend (`src-tauri/src/agent_hooks.rs`, `Cargo.toml`)

- Direct dep `toml_edit` (version already in tree).
- `SUPPORTED_AGENTS` += `"kimi"`; `AgentDescriptor` gains a non-serialized `format: ConfigFormat { Json, Toml }` (existing arms `Json`; the frontend-facing `Ownership` enum untouched).
- New descriptor arm: `dir_rel ".kimi-code"`, `config_rel ".kimi-code/config.toml"`, `Ownership::Merged`, `ConfigFormat::Toml`, events from `KIMI_EVENTS` (the minimal 9). Kimi stays out of `merge_agent_events` (JSON-only helper).
- New `provision_merge_toml_hooks(path, enabled, agent, relay)` mirroring `provision_merge_settings`'s contract: parse with `toml_edit::DocumentMut` (parse error → `io_err`, absent file + disabled → no-op), strip tables whose `command` contains the relay path, on enable push one table per event with **exactly** `event` + `command` = `command_str(...)`, tidy an emptied `hooks` array, `write_atomic`.
- `provision_agent` Merged arm routes by `desc.format`; `config_state` gains a Toml branch (parse failure → `ConfigError`, absent/no entries → `NotRegistered`) with a `toml_merge_is_current` check mirroring `merge_is_current` so `ensure_agent_hooks` self-heals stale event sets at launch.

### Fixtures & docs

- `src/lib/demo/fixtures.ts` — `"kimi"` in `installedAgentCommands`; `agentHookStatuses` entry (`~/.kimi-code/config.toml`, merged, the 9 events, registered).
- `CONTEXT.md` — **Agent** list gains Kimi Code; **Hook provisioning** gains `~/.kimi-code/config.toml`; **Subagent** gains Kimi's `SubagentStart`/`SubagentStop`.

### Tests

- `agents.test.ts` — builtin entry present; esc presses for kimi stay 2.
- `agentHookMap.test.ts` — kimi transition table incl. `Interrupt→idle`; subagent start/stop with `agent_id`.
- `statusReducer` tests — hook `"idle"` clears Working and drops the subagent set.
- `agent_hooks.rs` `#[cfg(test)]` — TOML merge add/strip idempotence with user comments surviving; only-allowed-keys guard; invalid TOML aborts untouched; stale event set reads not-registered then re-provisions cleanly; dir-gating (no-litter vs `create_dir`).

## Risks

- Kimi hooks are **Beta**; a malformed `[[hooks]]` entry makes kimi reject and
  ignore its **entire hooks section** — verified against kimi 0.27.0 ("Warning:
  Ignored invalid config … : hooks"): the CLI keeps working, but every hook,
  including the user's own, silently stops firing. Guards above.
- `agent_id` in subagent payloads and Interrupt firing on ESC are doc-derived —
  confirm live against the hook-server log.

## Runtime verification performed (2026-07-17, kimi 0.27.0)

- The exact nine `[[hooks]]` entries Abundio writes were appended to the real
  `~/.kimi-code/config.toml`: kimi's strict loader accepted them (no warning,
  CLI fully functional). Original file restored byte-identical afterwards.
- Negative test: adding an unknown key to one entry produced the
  hooks-section-rejection warning above, confirming the only-allowed-keys guard
  is load-bearing.
- Live hook *firing* could not be exercised (no model configured for
  non-interactive `kimi -p` in this environment) — first real in-app turn should
  be checked against the `[abundio:hook]` console log / hook-server stderr.

## Verification

1. `pnpm test`, `pnpm check`, `cd src-tauri && cargo test`.
2. Runtime: install kimi, enable Status Hooks, launch a kimi pane. Confirm:
   config.toml gains the entries with user content byte-intact and kimi still
   starts; Working → Ready across a turn; Waiting on a permission prompt;
   `PermissionResult` resumes Working; ESC-cancel fires `Interrupt` → Idle (no
   stale purple); SubagentStart holds Working past Stop; disabling the setting
   strips exactly Abundio's entries; Settings → Agents shows the kimi footprint;
   icon renders in LaunchPicker and on the pane.
