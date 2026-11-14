---
status: accepted
---

# Relaunched agents resume their own session by id

Until now every relaunch started a fresh agent session: opening a Workspace (app start, Fleet Console **Relaunch**) and restarting a Workspace's terminals for a changed injected Bundle all ran the agent's plain launch command. Now these automatic relaunches do a **Session resume**: the agent comes back into the conversation it last had in that pane. One global setting turns this off. It is on by default.

Each pane remembers its agent's own **Agent session id** next to its `agentId` in the layout. Every agent reports this id in its hooks; Abundio keeps the latest one and forgets it together with the agent. The relaunch command is then chosen like this:

1. **Id known:** resume that exact session (`claude --resume <id>`, `codex resume <id>`, `opencode --session <id>`, …).
2. **No id, and this is the only pane running that agent in its folder:** resume the agent's most recent session in that folder (`--continue`, Gemini `--resume latest`, `codex resume --last`).
3. **Otherwise:** start fresh.

There is **no fallback** to a fresh session. A resume that fails (a deleted session) leaves the agent's error in a plain shell. The agent process has exited, so the pane forgets the agent and its session, and the next relaunch does not retry it. Because the line is a single command, it works the same in every shell. **New task ▸ Restart agent never resumes:** a Task is new work with its own first prompt.

## Considered Options

- **Plain `--continue` everywhere.** It was the obvious choice, since every built-in agent has such a flag. Rejected because "most recent session in this folder" is the same session for every pane in that folder: two Claude panes in one Workspace would both reopen the same conversation, with two processes writing to it. This is also why rule 2 only applies when the pane is alone.
- **A `<resume> || <plain>` fallback**, so a failed resume starts a fresh session. Built first, then rejected: `||` fires on *any* non-zero exit, and Copilot exits 1 when the user quits it with Ctrl+C, so quitting a resumed Copilot started a fresh one unasked. A shell cannot tell "the resume failed" from "the user quit". Only firing when the resume exits within a few seconds would need a timing form per shell (and none for cmd.exe).
- **Checking that the session exists before launching** (for example, looking for the agent's session file on disk). Rejected: every agent stores sessions differently, and that layout can change between versions.
- **Dropping the old scrollback when resuming**, so the conversation does not appear twice. Rejected: if the resume fails, the pane would be blank.

## Consequences

- Custom agents have no hooks, so they never get an id. They get an optional "Continue arguments" field, used only under rule 2.
- Ids from sub-agents must not overwrite the pane's id. Copilot child tool hooks, Vibe events with a `parent_session_id`, and OpenCode `scope: "child"` events all carry a sub-agent's own id.
- Copilot's hook field is `sessionId`, confirmed by a live run (see `docs/plans/session-resume.md`). An unknown id makes `copilot --resume=` exit 1, so the fallback applies.
- OpenCode (`--session`) and Vibe do not fail on an unknown id; they quietly start fresh, which gives the same result as the fallback.

## Amendment (2026-11-14): one quick retry

A first Orchestrator (ADR-0057) showed the cost of no fallback plainly: the only pane in a fresh folder is "alone", so it got `claude --continue`, which failed with "No conversation found to continue" and left the user at a shell. The same happens to any Agent pane relaunched in a folder that never had a conversation.

So a resume now gets **one retry, decided in the app, not the shell**. A relaunch line that resumes is typed with its plain line beside it (`PendingAgent.fallback`). If shell integration reports that command ended with a **non-zero exit within 8 seconds** of being typed, the plain line is typed once, and the pane stays in agent mode with its Agent and handle (`lib/resumeFallback.ts`, the `command_end` branch in `terminalManager`). The window is what the rejected timing form was after, without a form per shell: an Agent that failed to resume dies within a second or two, while one the user worked in and then quit with Ctrl+C is long past it. A shell without shell integration reports no exit code and keeps the old behaviour.

The Orchestrator also never asks to resume when its Agent was just picked or changed: there is nothing of that Agent's to resume.

