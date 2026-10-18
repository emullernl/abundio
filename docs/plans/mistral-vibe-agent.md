# Mistral Vibe agent

Add Mistral Vibe (`vibe`, PyPI `mistral-vibe`) as a built-in Agent with live status. Design and trade-offs: ADR-0047. New term: **Title status** (GLOSSARY.md).

## What Vibe gives us

Facts below come from the docs (docs.mistral.ai/vibe/code/cli/hooks) and from the `mistralai/mistral-vibe` source (main, October 2026; PyPI 2.26.1).

- **Hooks:** `pre_tool`, `post_tool` and `post_agent` only.
  - Config files: `~/.vibe/hooks.toml` (really `$VIBE_HOME/hooks.toml`), plus a project `.vibe/hooks.toml` in trusted folders.
  - Entry shape: `[[hooks]]` with `name`, `type`, `command`.
  - Unknown keys are ignored. A duplicate `name` is dropped (first wins).
  - Each hook gets a stdin JSON with `session_id`, `parent_session_id`, `transcript_path`, `cwd` and `hook_event_name`.
  - Hooks are awaited one after another, so each one adds its run time to the agent.
- **`post_agent`:** fires after each assistant turn that ends with no pending tool calls. It never fires on cancel (Esc or Ctrl+C) or on an API error.
- **Title:** `textual_notification_adapter.py` writes OSC 0.
  - Focused terminal: `>> <title>` while running, `? <title>` while an approval prompt or question waits, the plain title when idle.
  - Blurred terminal, after the bell: `<title> - Action Required` / `<title> - Task Complete`.
  - Needs `experimental_enable_tab_status` (default on).
  - The Rust TUI (`vibe-rs`) sets the same titles.
- **Esc:** one press interrupts a running Turn. Double Esc applies only when idle (it clears the input or opens rewind).
- **Subagents:** child sessions with a non-null `parent_session_id`. They inherit the parent's hooks, and with the unified harness they can outlive the parent's Turn.
- **Task launch:** `vibe "<prompt>"` starts the interactive TUI and submits the prompt as the first turn.

## Status mapping

| Signal | Status |
|---|---|
| Title `>> ` (from outside a Turn) | Working, opens a Turn |
| Title `>> ` (from Waiting) | Working, same Turn |
| Title `? ` or `… - Action Required` | Waiting |
| `post_agent` hook | Ready |
| Title loses its prefix, no `post_agent` within 1.5 s | Idle (cancel or failure) |
| Esc while Working | Idle (keystroke path, single press) |
| Any hook with `parent_session_id` | ignored |

## Commits

1. **Rust:** Vibe Hook provisioning. `agent_hooks.rs` gets a `vibe` descriptor (Merged TOML, `VIBE_HOME`-aware). The TOML merge is generalised from Kimi-only to a per-agent schema: Kimi keys entries by `event`, Vibe by `type` plus a `name`.
2. **Title status machinery:**
   - `agentTitleMap.ts`: the rules and `titleStep`.
   - Reducer: a `title` event and a `titleTurnEnded` event, plus `titleHeld`, which suppresses the idle backstop.
   - Store: `applyTitleStatus` / `titleTurnEnded`.
   - Turn telemetry: `eventStartsTurn`.
   - terminalManager: wires `onTitleChange`, the grace timer and the hook gate.
3. **The Mistral Vibe built-in:** `agents.ts` (Task-capable, single Esc), the `agentHookMap.ts` mapping and Subagent filter, the icon, and tests.
4. **Demo and Statistics:** Vibe in the demo. The out-of-date hook footprints are corrected (Qwen, Grok, Codex, Copilot). Statistics gets colours and labels for Kimi, Grok and Vibe.
5. **Docs:** ADR-0047, this plan, GLOSSARY, README, CLAUDE.md and www.

## Live verification (not covered by unit tests)

- [ ] Launch `vibe` from the picker. `~/.vibe/hooks.toml` gains `abundio-post_agent`, and Settings ▸ Agents shows *Registered*.
- [ ] Send a prompt with no tools. The icon goes Working, then Ready.
- [ ] Trigger an approval prompt. The icon goes Waiting; approve it and the icon is Working again.
- [ ] Switch focus to another pane while Vibe waits for approval. The title becomes `… - Action Required` and the icon stays Waiting.
- [ ] Approve a prompt in a pane that was in the background. Statistics' Turn count goes up by exactly one.
- [ ] Press Esc mid-turn. The icon goes Idle, not Ready.
- [ ] Run a long tool (e.g. `sleep 60` via bash) that prints nothing. The icon stays Working past 30 s.
- [ ] New task with Vibe. The prompt arrives as the first turn.
- [ ] Turn tab status off in Vibe. The icon falls back to the byte heuristic and never sticks on Working, even after a background pane shows `… - Action Required`.
