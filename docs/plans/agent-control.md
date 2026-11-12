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

Error codes: `disabled`, `unauthorized`, `not_found`, `out_of_reach`, `not_an_agent`, `handle_taken`, `invalid_handle`, `busy` (Waiting, or a command is running), `state_unknown`, `stalled`, `timeout`, `cycle`, `not_owner`, `window_gone`, `unsupported_shell`, `empty_prompt` (nothing left once control characters are removed), `connection_lost`.

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

**Done.** As built, where it differs from or adds to the list below:

- The pane id comes from `log_id`, which the frontend already sets to the pane id; `pty_spawn` is unchanged. Only a spawn with both a Workspace id and a pane id gets a token. The token is revoked on kill, when the PTY thread ends (only that spawn's token, so a respawn under the same pty id keeps its new one), and when the spawn itself fails.
- `/control` is checked before the shared hook token and authenticates with `X-Abundio-Agent-Token` alone.
- `prompt --wait` is **one** request: the Window sends the prompt and waits, because the 5-second stall check must start when the prompt is sent. If the connection drops, the CLI retries with `X-Abundio-Retry`. Rust turns a retried `prompt --wait` into `agent wait`, and refuses a retry of any other call that changes something (`connection_lost`). Reads and waits simply run again.
- To check for a cycle, Rust first asks the Window to resolve the target (`{ op: "resolve", target }` → `{ result: { paneId } }`). Then it adds the edge, forwards the wait, and removes the edge when the wait ends.
- Window protocol: Rust emits `agent-control-request { id, caller: { ptyId, paneId, workspaceId }, request }` to the owning Window. `request` is tagged by `op` (`pane.list`, `agent.prompt`, …), and a target is `{ kind: "pane", value: 3 }` or `{ kind: "handle", value: "reviewer" }`. The Window answers with `agent_control_reply(id, { result } | { error: { code, message } })`. When Rust stops waiting (timeout) it emits `agent-control-cancel { id }`.
- HTTP status: 200 is the result (or help text); 400 is a usage error; 403 is `unauthorized` or `disabled`; 409 is any error the Window returns, plus `cycle` and `connection_lost`; 503 is `window_gone`; 504 is `timeout`.
- Calls that do not wait time out after 45 s; waits use their own timeout, and `--timeout 0` means no limit.
- Pane commands accept an Agent handle as well as a Pane number.
- Extra commands for the Window side: `agent_control_pane_numbers(workspaceId, paneIds)` and `agent_control_pane_for_number(workspaceId, number)`.
- Keys are validated here; mapping them to bytes is step 7.

The original list:

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

**Done.** As built:

- `ABUNDIO_CLI_SH` / `ABUNDIO_CLI_PS1` in `pty_manager.rs`, written as `abundio` and `abundio.ps1` by `write_abundio_cli`, next to `abundio-env`.
- No temporary file: curl appends the status on its own last line (`-w '\n%{http_code}'`), and the script splits it off.
- Retries, at most four attempts one second apart. curl exit 7 (refused) means the request never arrived, so it is retried as is. Exits 18, 52, 55 and 56 mean the connection dropped after the request went out, so it is retried with `X-Abundio-Retry`. PowerShell tells the two apart by a `SocketException` with `ConnectionRefused`.
- Tested by running the real script with a fake `curl` first on PATH (no sockets, so it runs in sandboxes too): argv bytes and token, empty argv, exit codes and streams, both kinds of retry, giving up, and refusing outside a pane.
- Known Windows gap: PowerShell swallows a bare `--` given to a script, so `agent start … -- <args>` needs `'--'` quoted there. Check this on Windows (see Verify).

The original list:

- `write_abundio_cli(dir)` in `pty_manager.rs`, next to `write_abundio_env_helper`, written to the same `shell-integration` folder (already on PATH in every PTY).
- sh: `printf '%s\0' "$@" | curl -s -m <timeout> --data-binary @- -H "X-Abundio-Agent-Token: $ABUNDIO_AGENT_TOKEN" http://127.0.0.1:$ABUNDIO_HOOK_PORT/control`. The script maps the HTTP status to the exit code and splits stdout/stderr. PowerShell twin for Windows.
- Outside an Abundio Pane (no token), print one line saying so and exit 1.
- `prompt --wait` sends the prompt, then the wait. On a dropped connection it retries only the wait, at most three times.
- No `eval`, as with `abundio-env`: the arguments are data.

### 5. The Window side: read-only calls

**Done.** As built:

- `lib/agentControl/`: `types.ts` (the request union, mirroring Rust; `ControlError`), `resolveTarget.ts` (`workspacePanes`: terminal panes Tab by Tab in Tab order, tree order inside; `resolveTarget`), `describe.ts`, `readBuffer.ts`, `handleControlRequest.ts` (`runRequest`, `toReply`, `startAgentControl`). IPC wrappers are `agentControl` in `lib/ipc.ts`.
- Only terminal panes get Pane numbers. Every call claims numbers for all the Workspace's terminal panes in `workspacePanes` order, then resolves against that map, so `agent_control_pane_for_number` is not needed by the Window. A number whose pane has closed is `not_found`.
- Answers `resolve` with `{ paneId }`. Ops from later steps answer `unsupported` until they land.
- Shapes: `pane list` → `{ panes: [...] }`, `agent list` → `{ agents: [...] }` (agent-mode panes only), `pane current` → one pane. A pane is `{ pane: "p3", number, handle, tab, self, mode, agent, status, cwd, title, command, spawnedBy }`; an Agent drops `mode` and `command`. `status` uses the glossary's words (`working`, not the store's `active`) plus `exited`.
- `pane read` → `{ pane, lines, text }`. Wrapped rows are joined, keeping the spaces inside a joined line; blank rows at the end are dropped; `--lines` counts joined lines. A pane with no mounted terminal is `state_unknown`. `TerminalPool` mounts every Tab of an Opened Workspace (the non-active ones after 2 s), so background Tabs can be read.
- A request Rust cancelled (timeout) is not answered when it finishes.
- Tests: target resolution (numbers, handles, misses, closed panes), pane order, description shapes and status words, buffer joining, and the handler over mocked IPC and terminals.

The original list:

- `lib/agentControl/` (new):
  - `handleControlRequest.ts`: hears `agent-control-request` with `listenToThisWindow` and dispatches.
  - `resolveTarget.ts` (pure): a handle or Pane number → pane id, using the Workspace's layouts across all its Tabs.
  - `describe.ts` (pure): the JSON shapes for panes and agents (number, handle, tab, Agent kind, status, mode, cwd, spawned-by).
- `pane list`, `pane current`, `agent list`, `pane read`. Read uses the xterm buffer of the pane's `ManagedTerminal`, joining wrapped lines; `--visible` limits it to the viewport. A pane whose terminal is not mounted yet is mounted by `TerminalPool` already for every Opened Workspace; check this holds for background Tabs.
- Register the listener in `App.tsx` only: File windows and Settings own no Workspace panes.
- Tests: resolving handles, numbers and misses; the JSON shapes; wrapped-line joining.

### 6. Handles, numbers and the Control badge

**Done.** As built:

- `lib/agentHandle.ts`: the grammar (same as Rust's, with the dialog's wording for each problem), `checkHandle` (unique across every Tab of the Workspace; a pane may keep its own), and `handleForPane`, which builds one pane → handle map per `workspaces` array for every title bar to share.
- `paneTree.setAgentId` drops the handle with the session when the Agent is cleared or replaced. One exception: a pane that had **no** Agent keeps its handle when its first Agent arrives, because `agent start` (step 8) names the pane before its Agent is detected. Re-stamping the same Agent changes nothing.
- `workspaceStore.setAgentHandle(paneId, handle | null)` returns `{ ok }` or `{ ok: false, code, message }`, which `agent rename` passes through as its error.
- Pane menu: "Name Agent…" / "Rename Agent…" (title case, like the other entries), enabled in agent-mode panes only. It opens `NameAgentDialog`; an empty name removes the handle.
- The handle shows as an accent-coloured name before the pane title, and before the title in a Fleet tile's bar and an Agent row (`reviewer · Fix the build`). The handle goes *first*, rather than replacing the title.
- Control badge: `stores/controlBadgeStore.ts` (counted per pane, so overlapping calls keep it up and it names the latest caller). It shows as `← p2` / `← reviewer` in the pane's bar and the Fleet tile's bar. It is shown for every call that targets *another* pane (`pane read`, `agent rename` now; the rest as they land). `resolve` and calls on one's own pane get none.
- `agent rename` requires an agent-mode pane (`not_an_agent`) and answers with the Agent's description.
- Tests: grammar (matching the Rust cases), uniqueness across Tabs, clearing on Agent change and keeping on first Agent, row title order, the badge counter, and `agent rename` through the handler (badge shown and cleared, layout written, clear with null, `not_an_agent`, `handle_taken`).

The original list:

- `workspaceStore`: `setAgentHandle(paneId, handle | null)`, checked for grammar and Workspace uniqueness. Clear it where `setAgentId` clears or changes the Agent, so it follows the Agent-mode rules (and the known nested-shell gap) exactly.
- Pane ⋯ menu: "Name agent…" (agent-mode panes only), using the app's own dialog components (no native `<select>`; padding inline).
- Show the handle on the pane title bar and in the Agent row (`lib/agentRowTitle.ts`: handle, then terminal title, then product name).
- Control badge: a short label on the target pane's title bar while a call runs, naming the caller's handle or number; cleared on reply. Kept in a small store keyed by pane id.
- `agent rename` command.
- Tests: grammar, uniqueness, clearing on Agent change, row title order.

### 7. Prompt, wait and keys

**Done.** As built:

- `lib/agentControl/settle.ts` (pure): `waitStep(goal, progress, snapshot)` and `isStalled`. A prompted wait (`needWorking`) ignores the state the Agent starts in, so the Ready left from its last turn is not an answer; Working already under way when the prompt goes out counts as seen. A plain `agent wait` ends at once if the target is already in the asked-for state. Either ends as `exited` if the Agent quits or the pane closes first. With `--until ready`, a Waiting or Error target keeps the wait open until Rust's timeout.
- `waitForPane.ts`: subscribes to `subscribeStatusChange` and also re-checks every 250 ms (a closed pane, an exited PTY and the 5 s stall deadline have no status event). It starts watching *before* the prompt is pasted, so a fast Agent's Working cannot be missed.
- Cancellation: each running request has an `AbortController`. `agent-control-cancel` aborts it, the wait unsubscribes, and no reply is sent.
- `agent prompt`: `not_an_agent` for a shell or exited pane, `busy` while Waiting (the Prompt action rule, `canFire`), `empty_prompt` if nothing is left after cleaning. `promptText.cleanPromptText` drops every control character except `\n` and `\t`, and turns CR/CRLF into `\n`. The paste and `\r` are `pasteAndSubmit`, extracted from `firePromptAction`; unlike a Prompt action it never moves focus. Reply: `{ pane, sent: true }`, or with `--wait` the Agent's description plus `status` (`ready`/`waiting`/`error`/`exited`) and `waitedMs`.
- `agent send-keys`: `keys.ts` maps every name Rust accepts. Arrows, Home and End follow the program's application-cursor mode (`ESC O A` vs `ESC [ A`), as a real key press does. All bytes go in one `pty_write`; an unknown name sends nothing. Any pane, any state: this is how a Waiting prompt is answered.
- Tests: settle sequences (Working → Ready / Waiting / Error, the left-over Ready, Working at the start, stall at 5 s, quitting, `--until`), key bytes in both cursor modes, the cleaner (keeps newlines, drops `ESC[201~`), and the handler with fake timers (prompt sent without focus, refusals, `--wait` settling and stalling, cancel, exit, send-keys bytes).

The original list:

- `agent prompt`: refuse unless the target is an agent-mode PTY (`not_an_agent`) and not Waiting (`busy`). Strip control characters except `\n` and `\t` (reuse the Prompt action parameter sanitiser), then send like `firePromptAction` without focusing the pane: `term.paste(text)`, then `term.input("\r")`. Extract the shared part of `firePromptAction` instead of copying it.
- `agent wait`: subscribe to the pane's status in `ptyActivityStore`. **Settled** = Ready, Waiting or Error after Working was seen. With `--until`, that state only. Reply `stalled` if no Working within 5 s of a prompt. The timeout is enforced in Rust; the Window drops its subscription when Rust cancels.
- `send-keys`: map logical key names to bytes (pure, tested), write through `pty_write`.
- Tests: settle logic as a pure function over status sequences (Working → Ready; Working → Waiting; no Working → stalled; already Working at the start); sanitiser keeps newlines and drops `ESC[201~`; key mapping.

### 8. Start, split, run, close

**Done.** As built:

- `lib/agentControl/spawn.ts` (pure): `autoDirection` (right when `cols ≥ 2 × rows`), `layoutDirection` (Split Right is a `vertical` split), `startArgv`, `runRefusal`, `cleanCommand`, `closeRefusal`.
- `pane split`: wraps the caller's pane in a split, in the caller's own Tab. The new node is an empty terminal (`ptyId: ""`, so it spawns when it renders) with `spawnedBy` set to the caller. Focus stays put unless `--focus`, which reveals the new pane (switching to its Tab). Reply: the new pane as `pane list` shows it, which also gives it its number.
- `agent start`: the argv is the Agent's command and args, then the caller's `--` args, then (with `--prompt`) its Task arguments with the prompt as one element. Without `--prompt` it still goes through the task path, just with no prompt.
  - Refused:
    - `not_found` for an unknown or switched-off Agent (the message lists the ones that are on).
    - `unsupported` for `--prompt` to an Agent that is not Task-capable.
    - `unsupported_shell` for anything but zsh or bash.
    - `handle_taken` / `invalid_handle`.
    - All of these are checked before anything is split.
  - Hooks are ensured first (capped at 2 s), as a split launch does.
  - The pending task is seeded under a pre-made pane id **before** the node enters the layout, so the terminal cannot spawn first and miss it. If the split fails, the seed is taken back.
  - Reply: once the pane is in agent mode, with the Agent's description; `stalled` after 30 s.
- `pane run`: refused for an exited shell (`not_found`), an agent-mode pane or a running command (`busy`), and a PTY where shell integration has not reported yet (`state_unknown`). That last signal is new: `ManagedTerminal.shellIntegrationSeen`, set on the first shell-integration sequence and reset by `restartPanePty`. After an app restart a reconnected shell is `state_unknown` until its next prompt. The command is made one line with no control characters, then written with `\r`.
- `pane close`: only a Spawned pane, only by its owner, never one's own pane (`not_owner`).
  - **Changed from the plan:** no confirmation. Every user close asks "Close pane?", and that dialog would stop an Agent cold. The unsaved-edits checks only concern file panes, and a Spawned pane is always a terminal.
  - The close logic moved out of `useSplitPane` into `lib/closePane.ts`, used by both. The user's close behaves as before. Agent control passes `keepFocus`, so focus stays where the user has it.
  - Closing any terminal pane now frees its Spawned panes in every Tab of its Workspace (`paneTree.clearSpawnedBy`).
- Tests: split direction and the layout mapping, the start argv (extra args, prompt last, multi-word command, option-safe prompt, refusals), run refusals and the command cleaner, close ownership, `clearSpawnedBy`. The handler is tested for split, start (seeded task, handle, hooks, answer in agent mode, 30 s stall, shell and handle refusals), run and close. `closePane` is tested for freeing Spawned panes and for focus with and without `keepFocus`.

The original list:

- `pane split`: split the caller's pane, right if its width is at least twice its height in cells, else down; never focus unless `--focus`. Mark the new node `spawnedBy: caller`, give it a number.
- `agent start`: split as above, then launch through the New task path (`pendingAgentRegistry.setPendingTask` → `pty_spawn` `task`), with the optional `--prompt` as the task prompt and the handle set on the new node. Reply once the PTY is in agent mode and Idle or Ready, or with `stalled` after 30 s. zsh and bash only, as for New task (`unsupported_shell`).
- `pane run`: refuse unless shell integration shows the shell at its prompt and the PTY is not in agent mode (`busy`, `state_unknown`); then write the command and `\r`.
- `pane close`: only if the target's `spawnedBy` is the caller (`not_owner`). Goes through the normal close path, including its unsaved-edits checks. When a pane closes, clear `spawnedBy` on every node that pointed at it.
- Tests: split direction; ownership on close and on owner close; run refused while a command runs.

### 9. Skill provisioning

**Done.** As built:

- The skill text is `src-tauri/skill/SKILL.md`, compiled in with `include_str!`. Its first instruction is to stop unless `ABUNDIO_AGENT_TOKEN` is set.
- `agent_skills.rs`: `provision_at(paths, enabled, watched)` and `status_at(paths)`, with paths passed in so the tests run in a temporary folder.
  - **Shared copy** `~/.agents/skills/abundio/` (`SKILL.md` plus the marker `.abundio-managed`): present while the setting is on and any Watched Agent other than Claude Code reads that folder. Otherwise it is removed.
  - **Claude Code entry** `$CLAUDE_CONFIG_DIR/skills/abundio`, else `~/.claude/skills/abundio`: present while the setting is on, Claude Code is Watched and its config folder already exists (no litter). It is a link to the shared copy when there is one and a link can be made. Otherwise it is a marked copy of its own (Claude Code alone; Windows without symlink rights). A link whose shared copy went away becomes a copy.
  - Files are rewritten only when their text differs.
  - Anything at either place that Abundio did not write is left alone: no marker, or a link pointing elsewhere. It is reported as a conflict (an error when the skill is wanted there, silence when removing).
- Commands: `agent_skill_provision`, `agent_skill_provision_startup` (once per process, its own `SkillStartupGuard`), `agent_skill_status` (each place's path and state: `absent`, `installed`, `outdated`, `linked`, `conflict`).
- `settingsStore.agentSkillEnabled`, on by default. An install whose saved settings predate it reads it as on, so upgrades get the skill with no migration.
  - Startup provisioning always runs, on or off, so switching it off removes the skill on the next start too.
  - The skill re-syncs wherever hooks do (an Agent toggled, the `$PATH` seeding, retired built-ins pruned), even while Status Hooks are off. `setAgentSkillEnabled` re-syncs too.
- Left for step 10: the Settings toggle and showing `agent_skill_status` in the Provisioning footprint.
- Tests:
  - Rust: write with marker, rewrite when changed, untouched when equal, removal when off or unread, a foreign folder or link never touched, nothing for Claude without its folder, the link and its removal, Claude alone as a copy, a dangling link becoming a copy.
  - Store: re-sync on toggle (also with hooks off), the setting off, startup on a fresh profile, on an upgraded one, and when off.

The original list:

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
