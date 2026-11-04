# Plan: Session resume for relaunched agents

## Context

Every automatic relaunch starts a fresh agent session today. When a Workspace opens (app start, Fleet Console **Relaunch**), `seedPendingAgentsForLayout` types the agent's plain launch command. The Environment Bundle restart (`restartWorkspacePtys`) does the same. The user wants these relaunches to come back into the agent's earlier conversation. Claude Code and Copilot both have `--continue`, and the other built-ins have something similar.

The decisions were settled in a grilling session. They are recorded in **ADR-0050**, and in `GLOSSARY.md` under **Session resume** and **Agent session id**.

## Design decisions (resolved with the user)

- **Which paths resume:** Workspace open / app start (this includes Fleet **Relaunch**) and the Environment Bundle restart. **New task ▸ Restart agent never resumes**, because a Task is new work.
- **How the command is chosen** (pure function, see step 1):
  1. The pane knows its **Agent session id** → resume that session.
  2. No id, and the pane is the **only pane running that agent in its launch folder** → continue the agent's most recent session in that folder.
  3. Otherwise → the plain launch command.
- **No fallback** (changed after review): the typed line is the resume command alone. A `|| <plain>` fallback also fired when the user quit a resumed agent with a non-zero exit (Copilot exits 1 on Ctrl+C). A failed resume leaves the agent's error in a plain shell.
- **Storage:** `agentSessionId` on the terminal `PaneNode`, next to `agentId`. The latest id wins. It is dropped whenever `agentId` is cleared or changes to a different agent.
- **Scrollback:** unchanged. It is still restored, so the conversation may appear twice.
- **Setting:** one global `resumeAgentSessions` in `settingsStore`, **on by default**, with a toggle in Settings ▸ Agents.
- **Custom agents:** an optional "Continue arguments" field. Used only under rule 2, because custom agents have no hooks and so no id.

## Per-agent facts

Checked against the installed CLIs, their source and their docs. Copilot and Claude Code were also tested live (see the end of this plan).

| Agent | Resume by id | Continue latest in folder | Hook field for the id | Unknown id |
|---|---|---|---|---|
| Claude Code | `--resume {session}` | `--continue` | `session_id` (**tested**) | error, exit 1 (**tested**) |
| Copilot | `--resume={session}` | `--continue` | `sessionId` (**tested**) | error, exit 1 (**tested**) |
| Gemini | `--resume {session}` | `--resume latest` | `session_id` | error exit |
| Codex | `resume {session}` (subcommand) | `resume --last` | `session_id` | error |
| OpenCode | `--session {session}` | `--continue` | `sessionID`, only when `scope: "self"` | starts fresh |
| Qwen | `--resume {session}` | `--continue` | `session_id` | exit 1 |
| Kimi | `--session {session}` | `--continue` | `session_id` | probably an error |
| Grok | `--resume {session}` | `--continue` | `sessionId` | probably an error |
| Vibe | `--resume {session}` | `--continue` | `session_id`, ignore when `parent_session_id` is set | stays open, fresh |

**Ignore sub-agent ids.** Some events carry a sub-agent's own id instead of the pane's session: OpenCode `scope: "child"`, Vibe events with `parent_session_id`, and Copilot child tool hooks. Abundio does not provision Copilot tool hooks other than `preToolUse` for two tools, so this needs a check there: a `preToolUse` inside a sub-agent might carry the child's `sessionId`. The safe rule is to take Copilot's id only from `userPromptSubmitted`, `agentStop` and `sessionEnd`.

## Changes: ordered commits on `feat/session-resume`

### 1. Agent definitions and the pure command choice

- `lib/types.ts`: add to `CodingAgent` `resumeArgs?: string[]` (exactly one element `{session}`) and `continueArgs?: string[]`.
- `lib/agents.ts`: fill both for the nine built-ins from the table. Like `taskArgs`, built-in values come from code in `mergeAgentsWithBuiltins`, never from the saved copy.
- New pure `agentRelaunchCommandFor(agents, agentId, { sessionId, alone, resume })` next to `agentCommandFor`. It returns the typed line: the resume command or the plain command. The rules:
  - Use the session id only if it matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`. The id comes from a hook payload and is typed into a shell, so anything else means "no id". The first character may not be `-` (review of PR #249): resume flags with an optional value would read such an id as an option, e.g. `claude --resume --dangerously-skip-permissions`.
  - (Removed after review: the per-shell `||` / PowerShell 5.1 fallback forms.)
  - Keep `agentCommandFor` as the plain form, and build on it, so the plain half of the line cannot drift.
- Tests: every rule (id / alone / neither / resume off / invalid id / unsupported shell / custom agent with and without continue args / Codex subcommand ordering with `args`).

### 2. Capture the Agent session id

- New pure `lib/agentSessionId.ts`: `agentSessionIdFrom(agentId, event, payload): string | undefined`, using the per-agent field and the sub-agent exclusions above. Tests with payload fixtures for every agent (Copilot's from the live test).
- `lib/paneTree.ts`: `setAgentSessionId(tree, paneId, id)` with structural sharing (no-op when unchanged). `setAgentId` drops `agentSessionId` when it clears the agent or changes it to a different one.
- `workspaceStore`: `stampAgentSessionOnPane(paneId, id)`. It must not write to the DB when the id is unchanged; it runs on every hook.
- `terminalManager` hook handler (around `adoptAgent`, ~1824): stamp the id after adoption. A **Session end** still stamps its id; it never adopts agent mode, but the id it carries is the same session.
- Tests: paneTree helpers and the store action.

### 3. Wire the relaunch paths

- `workspaceStore.seedPendingAgentsForLayout` (both call sites, ~392 and ~751): compute "alone" across **all** loaded Workspaces' layouts: count panes per (agentId, launch folder), where the launch folder is `pane.cwd ?? workspace.rootFolder`. Pass the result to `agentRelaunchCommandFor`. The function now needs the Workspace for the folder, so its signature changes.
- `paneRestart.restartWorkspacePtys` / `restartUnmountedPane`: the same, with the id read from the pane's layout node.
- `restartPaneWithTask`: unchanged (plain Task launch).
- `settingsStore`: `resumeAgentSessions: true`, persisted and part of the cross-window settings sync like the other agent settings.
- Settings ▸ Agents: the toggle ("Resume the last session when agents relaunch") and the custom agent's "Continue arguments" field, parsed like `parseTaskArgsForm` (an empty field means none). Use `PromptActions/Select.tsx`-style controls; padding goes inline (see the `CLAUDE.md` notes).
- `ApplyEnvToTerminalsDialog` copy: it no longer always "loses the current session". Say agents resume their session when they can.
- Tests: the "alone" counting (pure helper in `lib/`), and seeding with and without an id.

### 4. Docs

- `CLAUDE.md` Key Conventions: one bullet. Relaunch commands come from `agentRelaunchCommandFor`; session ids are validated before typing; New task never resumes. See ADR-0050.

## Verification

Unit tests are not enough here (the status-machine and hook-flow lesson). Run `pnpm tauri dev` and check:

1. Claude pane, send a message, quit, relaunch → the same conversation is back. The pane's layout row in the DB shows `agentSessionId`.
2. Copilot, the same.
3. Two Claude panes in one Workspace → each comes back into its own conversation.
4. `/clear` in Claude, then quit and relaunch → the *new* session comes back.
5. Delete the session's file on disk, then relaunch → the agent's error stays in a plain shell, and the next relaunch does not retry it.
6. Turn the setting off → fresh sessions, as before.
7. New task ▸ Restart agent → a fresh session with the Task.
8. Environment Bundle "Apply to terminals" → agents resume.

## Copilot live test (done, 2026-11-04)

A temporary hook file in `~/.copilot/hooks/` (removed afterwards) dumped each payload. Results:

- Every event (`sessionStart`, `userPromptSubmitted`, `agentStop`, `sessionEnd`) carries **`sessionId`** (camelCase), the same UUID Copilot prints as `copilot --resume=<id>`.
- `copilot --resume=<id>` kept the same `sessionId` and the earlier conversation.
- An unknown id prints `Error: No session, task, or name matched '<id>'` and **exits 1**.

## Claude Code live test (done, 2026-11-04)

Claude Code 2.1.318, run as `claude -p` in a throwaway folder with no tools. The hooks were passed in with `--settings`, so `~/.claude` settings were not changed. Results:

- Every event (`SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`) carries **`session_id`**, the same id `--output-format json` reports.
- `claude --resume <id>` kept the same `session_id` and the earlier conversation (it remembered "PINEAPPLE").
- An unknown id prints `No conversation found with session ID: <id>` and **exits 1**.
- `claude --continue` in a folder with no earlier session **started fresh** (exit 0). This is not the error the research expected; checked in `-p` mode only.

## Exit code on Ctrl+C (review of PR #249, 2026-11-04)

Copilot 1.0.105, quit with Ctrl+C twice in a real terminal, **exits 1**. So a `<resume> || <plain>` fallback would start a fresh Copilot every time the user quit a resumed one that way. The fallback was dropped.
