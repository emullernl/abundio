# Mistral Vibe status comes from its terminal title, plus one hook

Mistral Vibe's hooks (`pre_tool`, `post_tool`, `post_agent`) cannot drive the status icon on their own. There is no hook for "prompt submitted", none for "waiting for approval" (`pre_tool` fires *before* Vibe decides whether to ask), and none for cancel, error or session end. Vibe does announce its state in its own terminal title, though: `>> <title>` while a Turn runs, `? <title>` while an approval prompt or question waits, the bare title otherwise. In a blurred terminal it swaps the prefix for a suffix (`<title> - Action Required` / `<title> - Task Complete`) once it has rung its bell. So Working and Waiting come from the title, a **Title status**, and Abundio registers exactly one hook, `post_agent`, for the one thing the title cannot say: the Turn *finished*, rather than being cancelled or failing.

## Considered Options

- **Hooks only** (`pre_tool` → Working, `post_agent` → Ready, the byte heuristic for the turn start). Rejected: it never shows Waiting, and a reply with no tool calls shows Working late or not at all.
- **Title only** (no Hook provisioning at all). Rejected: a cancelled or failed Turn would look exactly like a finished one, so every Esc would end on Ready.
- **Claude-style plugin hooks** (Vibe can discover a `.claude-plugin`). Rejected: Vibe drops `UserPromptSubmit`/`Notification`, and neither of its runtimes executes plugin hooks yet.
- **`--add-dir` to an Abundio-owned folder** instead of editing `~/.vibe/hooks.toml`. Rejected: undocumented behaviour, it grants the agent file access to that folder, and it does nothing when the user types `vibe` themselves (ADR-0003).

## Consequences

- While the title says busy, the idle backstop stands down: a long tool run prints nothing, yet the Turn is still running. A title that loses its prefix starts a 1.5 s grace window. If `post_agent` lands inside it (it travels over loopback HTTP, the title through the PTY stream, so either may arrive first), the pane goes Ready. If not, the pane goes Idle, so Esc, Ctrl+C and an API error all end on Idle, because nothing tells them apart.
- `post_agent` and the title are both ignored until the pane has shown a status *prefix*. With Vibe's `experimental_enable_tab_status` off, the hook would otherwise silence the byte heuristic for good, leaving no Working signal at all. A suffix is not enough: Vibe writes `… - Action Required` even with tab status off.
- Vibe Subagents inherit the parent's hooks and fire `post_agent` when they finish, so every event carrying a `parent_session_id` is dropped. Background Subagents that outlive the parent's Turn are therefore not shown (contrast ADR-0022).
- Only `post_agent` is registered. Vibe awaits every hook before continuing, so tool hooks would add a curl round-trip to each tool call.
- Hook provisioning merges one named entry (`abundio-post_agent`) into `$VIBE_HOME/hooks.toml` or `~/.vibe/hooks.toml`, never `config.toml`. Vibe ignores unknown keys, unlike Kimi, but a duplicate `name` is dropped (first wins, project file first), hence the prefix.
- The title rules live in a per-Agent table (`agentTitleMap.ts`), so another Agent with a title protocol is a data change.
- Coupling: the strings are Vibe internals (`_RUNNING_INDICATOR`, `_WAITING_INDICATOR`, `NOTIFICATION_TITLE_SUFFIXES`). A change there silently drops Vibe back to the byte heuristic. That fails safe, because the turn-finished hook is then ignored too.
