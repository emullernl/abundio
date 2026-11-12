# Agent control

Let an Agent in one Pane drive other Panes of its Workspace through an `abundio` command. See `GLOSSARY.md` (**Agent control**, **Agent handle**, **Pane number**, **Spawned pane**, **Settled**, **Control badge**, **Skill provisioning**) and ADR-0054.

## Why

Agents already run side by side in Abundio, but they cannot see or reach each other. A user who wants one Agent to review another's work, or to farm out a sub-task, has to copy text between Panes by hand. The pieces underneath exist: Agent hooks drive Pane status, the hook server gives PTYs a way back to the app, and New task can launch an Agent with a prompt without typing. What is missing is a surface Agents can call, and a way for them to learn it exists.

## Decisions (from the design session)

| Topic | Decision |
|-------|----------|
| Capabilities | List Panes and Agents; read a Pane; prompt an Agent and wait; start an Agent in a new Pane; send keys; run a command in an idle shell; close a Spawned pane. |
| Callers | Only processes inside the app's own Panes. Each PTY gets its own token; the token says who is calling (ADR-0054). |
| Reach | The caller's own Workspace only. |
| Transport | New routes on the existing hook server. The CLI is a thin client; Rust parses its arguments. |
| Who carries it out | The Window owning the Workspace. Rust checks and routes. |
| Approval | None. A Control badge on the target Pane while a call runs, and one log line per call in the app log. |
| Setting | "Let agents control panes" in Settings ▸ Agents, on by default. Off: every call fails with `disabled`. |
| CLI name | `abundio`, next to `abundio-env`. JSON output. |
| Addressing | An Agent handle (optional, unique in the Workspace) or a Pane number (`p1`, `p2`, never reused). Both are kept across restarts. Handles are set from the pane ⋯ menu ("Name agent…") or `abundio agent rename`. |
| Handle lifetime | Belongs to the Pane. Survives restart and Session resume. Cleared when the Pane's PTY leaves agent mode or another Agent takes over. |
| Start | Always a fresh Pane, launched through the New task path (prompt as argv, never typed). Split the caller: right if wide, down if tall. Keyboard focus stays put. |
| Prompt | Control characters are stripped except `\n` and `\t`. Refused while the target is Waiting. Sent like a Prompt action: bracketed paste, then `\r`. |
| Settled | Ready, Waiting or Error, after the target was seen Working. No Working within 5 s: `stalled`. |
| Wait timeout | 30 minutes by default; `--timeout <ms>`; `--timeout 0` means no limit. |
| Cycles | A wait that would close a loop (A waits on B, B waits on A) is refused. |
| Read | The terminal buffer as drawn (screen plus scrollback), from the Window. Not the PTY log. |
| Run | Only when shell integration says the shell is at its prompt and the PTY is not in agent mode. Shells without integration: refused as `state_unknown`. |
| Close | Only a Spawned pane, and only by the Pane that spawned it. If the owner Pane closes, its Spawned panes become ordinary Panes. |
| Skill | **Skill provisioning**, the same model as Hook provisioning: installed for every Watched Agent that supports skills, on new and upgraded installations; rewritten on every start; its own toggle next to Status Hooks. |

## The command

Every command prints one JSON object on stdout and exits 0. Errors print `{"error":{"code","message"}}` on stderr and exit 1; usage errors exit 2.

```
abundio pane list
abundio pane current
abundio pane read <pane> [--lines N] [--visible]
abundio pane split [--direction right|down] [--focus]
abundio pane run <pane> <command>
abundio pane close <pane>
abundio agent list
abundio agent start [--handle <h>] --kind <agent-id> [--prompt <text>] [--direction right|down] [-- <agent args>]
abundio agent prompt <agent> <text> [--wait] [--timeout <ms>]
abundio agent wait <agent> [--until ready|waiting|error|settled] [--timeout <ms>]
abundio agent send-keys <agent|pane> <key>...
abundio agent rename <agent> [<handle>]
abundio help [<group>]
```

`<pane>` is a Pane number. `<agent>` is an Agent handle or a Pane number. `--kind` takes the ids from `lib/agents.ts` (built-in and custom). Keys use logical names (`esc`, `enter`, `tab`, `ctrl+c`, `up`…); all keys are checked before any byte is written.

Error codes: `disabled`, `unauthorized`, `not_found`, `out_of_reach`, `not_an_agent`, `handle_taken`, `invalid_handle`, `busy` (Waiting, or a command is running), `state_unknown`, `stalled`, `timeout`, `cycle`, `not_owner`, `window_gone`, `unsupported_shell`.

Handle grammar: `[a-z][a-z0-9_-]{0,31}`, and never a Pane number (`p` followed by digits only), so the two never collide.

## Steps (ordered commits on one branch, `agent-control`)

Before running the app with step 2 in place, back up `abundio.db` (+ `-wal`, `-shm`): there are no down-migrations.

### 1. Research: which Agents support skills, and where

**Done (2026-11-12).** Every built-in Agent supports skills in the shared `SKILL.md` format (a folder per skill with a `SKILL.md` inside). Every one except Claude Code reads the shared folder `~/.agents/skills/`, according to its own docs:

| Agent | Personal skill folders it reads (own docs) | Reads `~/.agents/skills/` | Consent on use |
|-------|--------------------------------------------|---------------------------|----------------|
| Claude Code | `~/.claude/skills/` | No | No |
| Codex | `~/.agents/skills/` (the old `~/.codex/skills/` is no longer documented) | Yes | No; a skill can opt out of automatic use |
| Copilot CLI | `~/.copilot/skills/`, `~/.agents/skills/` | Yes | No |
| Gemini CLI | `~/.gemini/skills/`, `~/.agents/skills/` (the latter wins on a name clash) | Yes | **Yes**, a confirmation each time a skill activates |
| OpenCode | `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/` | Yes | Configurable (`allow` / `ask` / `deny`) |
| Qwen Code | `~/.qwen/skills/`, `~/.agents/skills/` | Yes | No |
| Kimi Code | `$KIMI_CODE_HOME/skills/` (default `~/.kimi-code/skills/`), `~/.agents/skills/` | Yes | No |
| Grok Build | `~/.grok/skills/`, `~/.agents/skills/`, plus paths in `~/.grok/config.toml` | Yes | No |
| Mistral Vibe | `~/.vibe/skills/`, `~/.agents/skills/`, plus `skill_paths` in `config.toml` | Yes | No |

Sources: each Agent's own skills page (code.claude.com, learn.chatgpt.com, docs.github.com, geminicli.com, opencode.ai, qwenlm.github.io, kimi.com, docs.x.ai, docs.mistral.ai).

The open-source `skills` installer (vercel-labs/skills) works the same way. It stores the one real copy in `~/.agents/skills/<name>/` and, for an Agent that does not read that folder, links its own folder to it (a junction on Windows), copying instead when a link fails. It honours each Agent's home variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `VIBE_HOME`) and the XDG config home for OpenCode.

What this means for step 9:

- Two places cover all nine: `~/.agents/skills/abundio/` (the real copy) and `$CLAUDE_CONFIG_DIR/skills/abundio` or `~/.claude/skills/abundio`, a link to it (a copy on Windows if the junction fails).
- The shared folder serves eight Agents at once, so it cannot follow one Agent's Watched toggle. It is present while *any* Watched Agent other than Claude Code reads it. Only the Claude Code entry follows Claude Code's own toggle.
- OpenCode reads both `~/.claude/skills/` and `~/.agents/skills/`, so it finds the skill twice under one name. Check in the real app that it shows once. If not, skip the Claude Code link while OpenCode is Watched and Claude Code is not.
- Gemini CLI asks the user each time the skill activates. Accept it: that is Gemini's own rule.
- The skill is visible to these Agents even when they run outside Abundio. Its first instruction (stop unless `ABUNDIO_AGENT_TOKEN` is set) covers that.
- Use the name `abundio`. If a skill of that name already exists and was not written by Abundio (no marker file), leave it alone and report it in Settings rather than overwrite it.

### 2. Storage (Rust)

**Done.** Changed from the first draft: Pane numbers live in their own table, not in the layout JSON. The frontend writes layouts from many places, and any write that forgot the field would silently drop the number.

- Migration `021_pane_numbers.sql`: `workspaces.next_pane_number` (the counter) and `pane_numbers (workspace_id, pane_id, number)`, both unique per Workspace, cascading on Workspace delete. Rows of closed panes stay; the counter alone prevents reuse.
- `workspace_store.rs`:
  - `pane_numbers(workspace_id, pane_ids)` returns each pane's number in the order given, claiming new ones in that order, in one transaction. Existing layouts are numbered the first time the Window lists them, in tree order. No load-time pass is needed.
  - `pane_for_number(workspace_id, number)` resolves a `pN` target. The caller checks the pane is still in a layout.
- `PaneNode` (terminal) gains `agentHandle` and `spawnedBy` (the owner's pane id). Both are filled in by later steps.
- Tests: order and stability; no reuse after a close; per-Workspace; survives reopening the database; removed with the Workspace.

### 3. Per-pane token and request routing (Rust)

- New `agent_control.rs`:
  - `AgentControlTokens`: token → `Caller { pty_id, pane_id, workspace_id, window_label }`. Issued in `pty_spawn` (the frontend already passes the pane id as `log_id`; pass it explicitly as `pane_id`), revoked when the PTY exits or is killed. Compared in constant time, like the hook token.
  - `PendingRequests`: request id → one-shot reply channel.
  - `WaitGraph`: caller pane → target pane for each open wait; refuses an edge that would close a loop.
  - `parse_args(argv) -> Request`: pure, fully unit-tested; it also produces the help text.
- `pty_manager.rs`: set `ABUNDIO_AGENT_TOKEN` at spawn, next to `ABUNDIO_PTY_ID`.
- `hook_server.rs`: route `POST /control` to `agent_control`, on its own thread per request (the accept loop is sequential; a 30-minute wait must not hold up hooks). The body is the CLI's argv, NUL-separated.
- Flow: check the token (`unauthorized`), the setting (`disabled`) and parse; resolve the Workspace's Window from `owner_windows`; emit `agent-control-request { id, caller, request }` to that Window with `emit_to_one_profile_window`-style targeting; block on the reply channel until the timeout. The Window answers with a new command, `agent_control_reply(id, result)`.
- Log one line per call: caller, target, action, outcome. Never the prompt text or the read text.
- The setting: stored in the app-global `settings` table (like `last_seen_version`), so it is one value for every Window and Rust can check it without asking one. Set from Settings through `agent_control_set_enabled`.
- Tests: token issue and revoke; a token from another Workspace is `out_of_reach`; cycle detection (direct, and a three-pane loop); argument parsing, including handles, keys, `--` passthrough and every usage error.

### 4. The `abundio` command

- `write_abundio_cli(dir)` in `pty_manager.rs`, next to `write_abundio_env_helper`, written to the same `shell-integration` folder (already on PATH in every PTY).
- sh: `printf '%s\0' "$@" | curl -s -m <timeout> --data-binary @- -H "X-Abundio-Agent-Token: $ABUNDIO_AGENT_TOKEN" http://127.0.0.1:$ABUNDIO_HOOK_PORT/control`. The script maps the HTTP status to the exit code and splits stdout/stderr. PowerShell twin for Windows.
- Outside an Abundio Pane (no token), print one line saying so and exit 1.
- `prompt --wait` sends the prompt, then the wait. On a dropped connection it retries only the wait, at most three times.
- No `eval`, as with `abundio-env`: the arguments are data.

### 5. The Window side: read-only calls

- `lib/agentControl/` (new):
  - `handleControlRequest.ts`: hears `agent-control-request` with `listenToThisWindow` and dispatches.
  - `resolveTarget.ts` (pure): a handle or Pane number → pane id, using the Workspace's layouts across all its Tabs.
  - `describe.ts` (pure): the JSON shapes for panes and agents (number, handle, tab, Agent kind, status, mode, cwd, spawned-by).
- `pane list`, `pane current`, `agent list`, `pane read`. Read uses the xterm buffer of the pane's `ManagedTerminal`, joining wrapped lines; `--visible` limits it to the viewport. A pane whose terminal is not mounted yet is mounted by `TerminalPool` already for every Opened Workspace; check this holds for background Tabs.
- Register the listener in `App.tsx` only: File windows and Settings own no Workspace panes.
- Tests: resolving handles, numbers and misses; the JSON shapes; wrapped-line joining.

### 6. Handles, numbers and the Control badge

- `workspaceStore`: `setAgentHandle(paneId, handle | null)`, checked for grammar and Workspace uniqueness. Clear it where `setAgentId` clears or changes the Agent, so it follows the Agent-mode rules (and the known nested-shell gap) exactly.
- Pane ⋯ menu: "Name agent…" (agent-mode panes only), using the app's own dialog components (no native `<select>`; padding inline).
- Show the handle on the pane title bar and in the Agent row (`lib/agentRowTitle.ts`: handle, then terminal title, then product name).
- Control badge: a short label on the target pane's title bar while a call runs, naming the caller's handle or number; cleared on reply. Kept in a small store keyed by pane id.
- `agent rename` command.
- Tests: grammar, uniqueness, clearing on Agent change, row title order.

### 7. Prompt, wait and keys

- `agent prompt`: refuse unless the target is an agent-mode PTY (`not_an_agent`) and not Waiting (`busy`). Strip control characters except `\n` and `\t` (reuse the Prompt action parameter sanitiser), then send like `firePromptAction` without focusing the pane: `term.paste(text)`, then `term.input("\r")`. Extract the shared part of `firePromptAction` instead of copying it.
- `agent wait`: subscribe to the pane's status in `ptyActivityStore`. **Settled** = Ready, Waiting or Error after Working was seen. With `--until`, that state only. Reply `stalled` if no Working within 5 s of a prompt. The timeout is enforced in Rust; the Window drops its subscription when Rust cancels.
- `send-keys`: map logical key names to bytes (pure, tested), write through `pty_write`.
- Tests: settle logic as a pure function over status sequences (Working → Ready; Working → Waiting; no Working → stalled; already Working at the start); sanitiser keeps newlines and drops `ESC[201~`; key mapping.

### 8. Start, split, run, close

- `pane split`: split the caller's pane, right if its width is at least twice its height in cells, else down; never focus unless `--focus`. Mark the new node `spawnedBy: caller`, give it a number.
- `agent start`: split as above, then launch through the New task path (`pendingAgentRegistry.setPendingTask` → `pty_spawn` `task`), with the optional `--prompt` as the task prompt and the handle set on the new node. Reply once the PTY is in agent mode and Idle or Ready, or with `stalled` after 30 s. zsh and bash only, as for New task (`unsupported_shell`).
- `pane run`: refuse unless shell integration shows the shell at its prompt and the PTY is not in agent mode (`busy`, `state_unknown`); then write the command and `\r`.
- `pane close`: only if the target's `spawnedBy` is the caller (`not_owner`). Goes through the normal close path, including its unsaved-edits checks. When a pane closes, clear `spawnedBy` on every node that pointed at it.
- Tests: split direction; ownership on close and on owner close; run refused while a command runs.

### 9. Skill provisioning

- The skill text (`SKILL.md`) lives in the repo. It teaches: check `ABUNDIO_AGENT_TOKEN` is set; `abundio help`; list before acting; address by handle or Pane number; prefer `agent prompt --wait`; read before re-sending after a timeout; never close panes it did not spawn.
- `agent_skills.rs` (or an extension of `agent_hooks.rs`): write `~/.agents/skills/abundio/` (with a marker file saying Abundio owns it) and the Claude Code link, following the rules found in step 1. Rewrite the copy on every start when its contents differ. Remove the shared copy when no Watched Agent reads it or the setting is off; remove the Claude Code link when Claude Code is un-Watched. Never touch an `abundio` skill folder without the marker. Follow `provision_own_file`: no litter in an Agent's config folder that does not exist.
- Setting "Install the Abundio skill for agents", next to Status Hooks, on by default. Show its paths in the Provisioning footprint display.
- Tests: write, rewrite on change, untouched when equal, removal, no folder created for an absent Agent.

### 10. Settings, demo, docs

- Settings ▸ Agents: the "Let agents control panes" toggle and the skill toggle.
- `lib/demo/`: mock `agent_control_reply` and the setting commands so `pnpm demo:web` keeps working; no control requests arrive in the demo.
- `CLAUDE.md`: add `agent_control.rs` and `lib/agentControl/` to the architecture list, plus a Key Conventions line: the caller is whatever its token says; the shared hook token is not a pane boundary.
- Release notes: say what the skill is and where it is installed.

## Verify in the real app

Unit tests will not catch the integration paths. Before calling it done:

- From a Claude Code pane: start a second Agent with a handle, prompt it with `--wait`, read its answer, then close its pane.
- Prompt an Agent that hits an approval dialog: the wait returns `waiting`.
- Quit and relaunch: handles and numbers come back, a resumed Agent keeps its handle.
- A call from a second Workspace's pane cannot see the first's panes.
- A cycle (A waits on B, B prompts A with `--wait`) is refused.
- Turn the setting off mid-wait: new calls fail with `disabled`, the open wait still ends.
- Put the Mac to sleep during a long wait: the CLI's wait retry recovers.
- Windows: the PowerShell client, and the shells it supports.
