---
status: accepted
---

# Relaunched agents resume their own session by id

Until now every relaunch started a fresh agent session: opening a Workspace (app start, Fleet Console **Relaunch**) and restarting a Workspace's terminals for a changed injected Bundle all ran the agent's plain launch command. Now these automatic relaunches do a **Session resume**: the agent comes back into the conversation it last had in that pane. One global setting turns this off. It is on by default.

Each pane remembers its agent's own **Agent session id** next to its `agentId` in the layout. Every agent reports this id in its hooks; Abundio keeps the latest one and forgets it together with the agent. The relaunch command is then chosen like this:

1. **Id known:** resume that exact session (`claude --resume <id>`, `codex resume <id>`, `opencode --session <id>`, …).
2. **No id, and this is the only pane running that agent in its folder:** resume the agent's most recent session in that folder (`--continue`, Gemini `--resume latest`, `codex resume --last`).
3. **Otherwise:** start fresh.

The command is wrapped as `<resume command> || <plain command>`, so a resume that fails starts a fresh session instead of leaving a bare shell. Windows PowerShell 5.1 has no `||`, so it gets `<resume>; if (-not $?) { <plain> }`. A shell with neither form (nushell, csh) gets the plain command. **New task ▸ Restart agent never resumes:** a Task is new work with its own first prompt.

## Considered Options

- **Plain `--continue` everywhere.** It was the obvious choice, since every built-in agent has such a flag. Rejected because "most recent session in this folder" is the same session for every pane in that folder: two Claude panes in one Workspace would both reopen the same conversation, with two processes writing to it. This is also why rule 2 only applies when the pane is alone.
- **Checking that the session exists before launching** (for example, looking for the agent's session file on disk). Rejected: every agent stores sessions differently, and that layout can change between versions. The `||` fallback works the same way for every agent. Its cost: if the user quits a resumed agent and it exits non-zero, a fresh one starts without being asked.
- **Dropping the old scrollback when resuming**, so the conversation does not appear twice. Rejected: if the resume fails, the pane would be blank.

## Consequences

- Custom agents have no hooks, so they never get an id. They get an optional "Continue arguments" field, used only under rule 2.
- Ids from sub-agents must not overwrite the pane's id. Copilot child tool hooks, Vibe events with a `parent_session_id`, and OpenCode `scope: "child"` events all carry a sub-agent's own id.
- Copilot's hook field is `sessionId`, confirmed by a live run (see `docs/plans/session-resume.md`). An unknown id makes `copilot --resume=` exit 1, so the fallback applies.
- OpenCode (`--session`) and Vibe do not fail on an unknown id; they quietly start fresh, which gives the same result as the fallback.
