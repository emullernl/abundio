# Agent control

Let an Agent in one Pane drive other Panes of its Workspace through an `abundio` command. See `GLOSSARY.md` (**Agent control**, **Agent handle**, **Pane number**, **Spawned pane**, **Settled**, **Control badge**, **Skill provisioning**) and ADR-0054.

## Why

Agents already run side by side in Abundio, but they cannot see or reach each other. A user who wants one Agent to review another's work, or to farm out a sub-task, has to copy text between Panes by hand. The pieces underneath exist: Agent hooks drive Pane status, the hook server gives PTYs a way back to the app, and New task can launch an Agent with a prompt without typing. What is missing is a surface Agents can call, and a way for them to learn it exists.

## Decisions (from the design session)

| Topic | Decision |
|-------|----------|
| Capabilities | List Panes and Agents; read a Pane; prompt an Agent and wait; start an Agent in a new Pane; send keys; run a command in an idle shell; close a Spawned pane. |
| Callers | Only processes inside the app's own Panes. Each PTY gets its own token; the token says who is calling (ADR-0054). |
| Reach | The caller's own Workspace only. **Changed by ADR-0055 (steps 16–20): every Workspace of the caller's Profile.** |
| Transport | New routes on the existing hook server. The CLI is a thin client; Rust parses its arguments. |
| Who carries it out | The Window owning the Workspace. Rust checks and routes. |
| Approval | None. A Control badge on the target Pane while a call runs, and one log line per call in the app log. |
| Setting | "Let agents control panes" in Settings ▸ Agents, on by default. Off: every call fails with `disabled`. |
| CLI name | `abundio`, next to `abundio-env`. JSON output. |
| Addressing | An Agent handle (optional, unique in the Workspace) or a Pane number (`p1`, `p2`, never reused). Both are kept across restarts. Handles are set from the pane ⋯ menu ("Name agent…") or `abundio agent rename`. |
| Handle lifetime | Belongs to the Pane. Survives restart and Session resume. Cleared when the Pane's PTY leaves agent mode or another Agent takes over. |
| Start | Always a fresh Pane, launched through the New task path (prompt as argv, never typed). Split the caller: right if wide, down if tall. Keyboard focus stays on the caller unless `--focus` (on `pane split` and `agent start`), which the Agent passes only when the user asks. |
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
abundio agent start [--handle <h>] --kind <agent-id> [--prompt <text>] [--direction right|down] [--focus] [-- <agent args>]
abundio agent prompt <agent> <text> [--wait] [--timeout <ms>]
abundio agent wait <agent> [--until ready|waiting|error|settled] [--timeout <ms>]
abundio agent send-keys <agent|pane> <key>...
abundio agent rename <agent> [<handle>]
abundio help [<group>]
```

`<pane>` is a Pane number. `<agent>` is an Agent handle or a Pane number. `--kind` takes the ids from `lib/agents.ts` (built-in and custom). Keys use logical names (`esc`, `enter`, `tab`, `ctrl+c`, `up`…); all keys are checked before any byte is written.

Error codes: `disabled`, `unauthorized`, `not_found`, `out_of_reach`, `not_an_agent`, `handle_taken`, `invalid_handle`, `busy` (Waiting, or a command is running), `state_unknown`, `stalled`, `timeout`, `cycle`, `not_owner`, `window_gone`, `unsupported_shell`, `empty_prompt` (nothing left once control characters are removed), `connection_lost`. A bad Tab name (steps 11–15) is a usage error, like a bad handle. Steps 16–20 add `ambiguous_workspace` and `folder_missing`.

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

**Done.** As built:

- Settings ▸ Agents has a new **Agent Control** group after the Status Hooks rows.
  - "Let agents control panes" reads and writes the Rust-held setting (`agent_control_enabled` / `agent_control_set_enabled`). It is not in `settingsStore`, so one value serves every Window and the `/control` route.
  - "Install the Abundio skill for agents" drives `agentSkillEnabled`. Under it, each place the skill goes is listed with its path and state (Installed, Linked, Outdated, "Not Abundio's — left alone", Not needed / Off). This is the skill's Provisioning footprint. It refreshes when the section opens and after the skill toggle; after toggling an Agent it shows the new state on the next open.
- `lib/demo/mockInvoke.ts` answers every new command (`agent_control_*`, `agent_skill_*`). `agent_skill_status` shows a sample footprint.
- `CLAUDE.md`: `agent_control.rs`, `agent_skills.rs`, `lib/agentControl/`, `lib/agentHandle.ts`, `lib/closePane.ts` and `stores/controlBadgeStore.ts` in the architecture lists. A Key Conventions entry says only the per-pane token is trusted, the shared hook token is not a pane boundary, and changing calls are not retried.
- Release notes: Abundio's notes are written on the GitHub release at release time (the in-app "What's new" reads them from there). There is no file in the repo for them, so the draft is below, to use then.
- Tests: the Settings group (the control toggle writes to Rust, the skill toggle goes through the store, the footprint lists both places with their states), `skillBadge`, and the demo commands.

#### Release notes draft

```markdown
## ✨ New Features & Improvements

- **Your agents can now talk to each other.** An agent in one pane can list the other panes of its workspace, read what they show, prompt another agent and wait for its answer, start a helper agent beside itself, or run a command in an idle shell, all through a new `abundio` command. It never reaches beyond its own workspace, and closes only the panes it opened itself, so no one is evicted mid-sentence. A small badge on a pane shows who is driving it. Turn it off in Settings ▸ Agents ▸ Let agents control panes. (#PR)
- **Agents learn the trick on their own.** Abundio installs an `abundio` skill for your watched agents, in `~/.agents/skills/abundio` (read by Codex, Copilot, Gemini, OpenCode, Qwen, Kimi, Grok and Vibe) and, for Claude Code, in `~/.claude/skills/abundio`. It is rewritten on every start and removed when you switch it off in Settings ▸ Agents. A folder of that name that Abundio didn't write is politely left alone. (#PR)
- **Give an agent a name.** "Name Agent…" in the pane menu gives it a handle such as `reviewer`, shown in its title bar and in the Agents list, which other agents can use to address it. (#PR)
- **Helpers get a room of their own.** An agent can open its helper in a new tab instead of squeezing it in beside itself, and name tabs (its own, and the ones it opened). When a split would leave the panes cramped, the agent is nudged to use a tab next time. A tab you renamed by hand keeps your name: agents leave it alone. (#PR)
```

The original list:

- Settings ▸ Agents: the "Let agents control panes" toggle and the skill toggle.
- `lib/demo/`: mock `agent_control_reply` and the setting commands so `pnpm demo:web` keeps working; no control requests arrive in the demo.
- `CLAUDE.md`: add `agent_control.rs` and `lib/agentControl/` to the architecture list, plus a Key Conventions line: the caller is whatever its token says; the shared hook token is not a pane boundary.
- Release notes: say what the skill is and where it is installed.

### Focus stays on the caller (after step 10)

In the real app the caller's pane lost keyboard focus when an Agent split it, although Agent control never moved focus. The cause was not Agent control. Splitting a pane re-parents its terminal: `projectInto` (`TerminalInstance.tsx`) moves the xterm element into the new split's container with `appendChild` and hides it until it has painted, and both drop the browser's focus. The slot's own refocus had already run, before the move. The same happened to the user's own splits, where the new pane taking focus hid it.

- Fix: when `projectInto` reveals a terminal, it calls `term.focus()` if that pane is the Focused pane (or Focused tile) and nothing else holds focus: focus is on `<body>`, or already inside the terminal (`lib/projectionFocus.ts`, pure and tested). So the user keeps typing to the Agent that made the split.
- First try, which did not work in the app: refocus only if the terminal had focus just before the projection. It never had. When the split replaces the old slot, the element is first retracted to its holding container, and that move already drops focus, so at projection time focus was on `<body>`.
- `agent start` gained `--focus`, like `pane split`: reveal the new pane at once and, in the Fleet Console, focus its tile once it is in agent mode. The help text and the skill say to pass it only when the user asks to be taken to the new pane.

## Tabs (second round: steps 11–15)

Agents can open an Agent or a shell in a new **Tab** instead of splitting their own, and can name Tabs. When the caller's Tab is getting crowded, the reply suggests a new Tab. See **Spawned tab** in `GLOSSARY.md`.

### Decisions

| Topic | Decision |
|-------|----------|
| CLI | `agent start … --tab [--tab-name <name>]` opens the Agent in a new Tab. `abundio tab new [--name <name>] [--focus]` opens a shell Tab. `abundio tab rename <name> [--tab <pane>]` renames a Tab. `pane split` stays a split. |
| Spawned tab | A Tab Agent control opens. Owned by the caller's pane, persisted, and becomes an ordinary Tab when that pane closes. |
| Rename reach | The caller's own Tab and its Spawned tabs. Never a Tab the user has named by hand: the user's name wins (`not_owner`). |
| Addressing | `tab rename` without `--tab` renames the caller's own Tab. `--tab p7` (or a handle) names the Tab holding that pane. No Tab numbers. |
| Close | No `tab close`. `pane close` on its Spawned panes; the Tab closes with its last pane. |
| Position | At the end of the Tab bar, like a user's New tab. |
| View | The user's view does not switch. `--focus` (passed only when the user asks) makes the new Tab active and focuses its pane. |
| Default name | With `--prompt`, the New task rule (`taskTabName`, the start of the task text). Else the Agent handle, else the Agent's name. A shell Tab gets the app's usual default name. |
| Crowded | The split still happens. The reply carries `hint` ("this Tab is crowded; consider --tab"). Crowded means either half of the split would be under 60 columns or 12 rows, or the Tab already holds 4 or more terminal panes. The skill says to prefer `--tab` after a hint, or when the user's Tab is busy. |

Tab names: one line, no control characters, 1–64 characters after trimming. A bad name is a usage error (exit 2), caught by the parser.

### 11. Storage

**Done.** As built:

- `022_tab_ownership.sql` adds both columns. `Tab` (Rust) carries `spawned_by_pane` and `user_named` in every query, including the joined Workspace list the frontend loads.
- `TabUpdate.spawned_by_pane` is `Option<Option<String>>`: left out means unchanged, `null` makes it an ordinary Tab again. A small `present` deserializer tells the two apart. `TabUpdate` now derives `Default`.
- Frontend `Tab` / `TabUpdate`: `spawnedByPane?` and `userNamed?`, optional so fixtures need not change.
- `renameTab(tabId, name, { byUser })`. The Tab bar's rename (`App.tsx`) is the only user path and passes `byUser: true`. New task names its Tab through `tabsApi.update` directly, so it never marks one.
- `workspaceStore.releaseSpawnedTabs(ownerPaneId)`, called from `closePane.ts` with the Spawned-pane release.
- Tests: Rust for defaults, setting, clearing with `null` and the joined list; `null` versus left out. Frontend for owner close releasing Tabs (and another pane's close not), and user versus app renames.

The original list:

- Migration `022_tab_ownership.sql`: `tabs.spawned_by_pane TEXT` (null for ordinary Tabs) and `tabs.user_named INTEGER NOT NULL DEFAULT 0`. Back up `abundio.db` first, as for 021.
- `Tab` / `TabUpdate` (Rust and `lib/types.ts`) gain `spawnedByPane` and `userNamed`.
- Every rename the user makes in the UI (Tab bar double-click and context menu, palette) sets `userNamed`. The app's own renames do not: New task naming its Tab, and Agent control. `workspaceStore.renameTab` gains an `{ byUser }` option and the UI call sites pass it. Tabs renamed before this ships count as not user-named: there is no record.
- When a pane closes, Tabs whose `spawnedByPane` is that pane become ordinary (`closePane.ts`, next to `clearSpawnedBy`).
- Tests: the migration on an existing database, the flags round-tripping, the UI rename setting `userNamed`, owner close releasing the Tab.

### 12. Parsing (Rust)

**Done.** As built:

- `agent start` takes `--tab` and `--tab-name <name>`. `--tab-name` without `--tab` is refused, and so is `--direction` with `--tab` (a new Tab has no split side).
- `tab new [--name <name>] [--focus]` and `tab rename <name> [--tab <pane|agent>]`; `--tab` takes a Pane number or a handle, like every other target. `tab close` is an unknown command.
- `check_tab_name`: trimmed, then 1–64 characters (`TAB_NAME_MAX`, counted in characters, not bytes), with no control characters. Every failure is a `usage` error, exit 2. There is no separate `invalid_name` code.
- `Request::TabNew` / `Request::TabRename` (ops `tab.new`, `tab.rename`); `AgentStart` gains `tab` and `tab_name`. Neither new request is in the read-only list, so neither is retried after a dropped connection.
- Help: a `Tabs:` group (`abundio help tab`), the `--tab` options on `agent start`, and a line on crowded hints in the header.
- The TypeScript request union matches. Until step 13 the Window answers the new ops with `unsupported`.
- Tests: every new form, each usage error, the name limits (64 multi-byte characters pass, 65 fail), help, retry and op names.

The original list:

- `agent start` gains `--tab` and `--tab-name <name>` (the latter only with `--tab`). New group `tab`: `tab new [--name <name>] [--focus]` and `tab rename <name> [--tab <pane|handle>]`.
- `Request::TabNew { name, focus }`, `Request::TabRename { name, target }`; `AgentStart` gains `tab: bool`, `tab_name`. Both new requests change something, so they are not retried after a dropped connection.
- Name checks in the parser (a bad name is a usage error, exit 2).
- Help text: the `tab` group, the `--tab` options, and one line on crowded hints.
- Tests: every new form and usage error.

### 13. The Window: new Tabs and renames

**Done.** As built:

- `createTab` gains `name` (over every default) and `spawn: { ownerPaneId, handle? }`. The owner goes on the Tab and on its pane (`spawnedBy`, plus the handle), written to `tab.layoutJson` and the Tab row before the Tab reaches the store. Nothing can render and spawn without them. Patching the layout afterwards could have overwritten the pane's real `ptyId` once its terminal had spawned.
- `openSpawnedTab` (handler) is shared by `agent start --tab` and `tab new`. It always creates with `activate: false` (the Fleet Console's New agent path), then, with `--focus`, calls `revealPane` on the new Tab. The user's active Tab and Focused pane are untouched otherwise. The Agent's argv rides the spawn through `createTab`'s task seed, as for New task's New tab.
- Default names: `--tab-name`; else `taskTabName` of the prompt (New task's rule, 30 characters with an ellipsis); else the handle; else the Agent's name. `tab new` without `--name` gets `createTab`'s own default (`Terminal N`).
- `tab rename`: the caller's own Tab, or the one holding `--tab`'s pane. `spawn.tabRenameRefusal` (pure) refuses a Tab that is neither the caller's nor opened by it, and any user-named Tab (`not_owner`). The rename goes through `renameTab` without `byUser`, so it never marks the Tab user-named. Reply: `{ tab, renamed: true }`.
- Replies: `agent start --tab` answers like `agent start` (its `tab` is the new Tab's name). `tab new` answers with the new pane's description.
- Not done, unlike the first draft: the Control badge on the new pane. `agent start` never showed it for a split either: the badge marks a pane another Agent is driving, and a new pane is not being driven yet.
- Tests: Tab at the end with its owner on the Tab, on the pane and in the Tab row; task seeded for the new pane; the user's Tab and focus unchanged; each default name; `--focus` revealing; `tab new` (default name, `--name`, `--focus`); rename of own and spawned Tabs, refusal of another Tab and of a user-named one; `tabRenameRefusal`.

The original list:

- `agent start --tab`: `createTab(workspaceId, agent, seed, { activate: focus, task })`, with the pane node carrying `spawnedBy`, `agentHandle` and `agentId` as in a split, and the Tab marked `spawnedByPane: caller`. The task seed rides the spawn exactly as in step 8. Reply: the Agent's description (which already names its `tab`).
- `tab new`: the same, with a plain shell pane. Reply: the new pane's description.
- `--focus`: the new Tab becomes the active Tab and its pane the Focused pane. Without it, the Tab is added without activating (the Fleet Console's New agent path) and focus stays on the caller.
- `tab rename`: resolve the Tab (the caller's, or the one holding `--tab`'s pane). Refuse unless it is the caller's own Tab or `spawnedByPane` is the caller (`not_owner`), and refuse if `userNamed` (`not_owner`, "the user named this Tab"). Then `renameTab` without `byUser`. Reply `{ tab, name }`.
- The Control badge shows on the new pane while `agent start --tab` runs, as for a split.
- Tests: Tab created at the end with the right owner, name rules (prompt, handle, Agent name, shell default), `--focus` on and off, rename reach (own, spawned, other, user-named).

### 14. Crowded hint

**Done.** As built:

- `crowding.ts`: `crowdHint` with `MIN_COLS` 60, `MIN_ROWS` 12 and `MAX_PANES` 4. Only the side the split halves is halved, and one cell goes to the divider (121 columns split right gives 60 + 60, so no hint; 120 gives 59, a hint). The side not halved counts as it is, so a down split of a 50-column pane hints too. The pane count is the Tab's terminal panes before the split.
- The hint names the reason ("this Tab already had 4 panes", or "the new panes are only 59 columns × 40 rows") and ends with the advice to use `--tab`.
- `splitCaller` returns `{ paneId, hint }`. `pane split` and `agent start` (split) add `hint` only when it is non-null. `agent start --tab` and `tab new` never carry one.
- Skill: a section "In a Tab of its own". It says when to prefer `--tab` (a `hint`, a busy Tab, long separate work), what `--tab-name` and `tab rename` are for, and that a Tab the user named is left alone. `--focus` is listed for `tab new` too.
- Tests: each threshold exactly at its limit, both directions, the side not halved, the pane count, the reason in the text. Replies: no hint with room, a hint (and still a split) when cramped, never with `--tab`.

The original list:

- `lib/agentControl/crowding.ts` (pure): `crowdHint({ terminalPanes, cols, rows, direction })` returns a hint string or null. The halves are computed from the caller's grid as the split would make them (half the columns for right, half the rows for down).
- `pane split` and `agent start` without `--tab` add `hint` to their reply when it is non-null. A reply with `--tab` never carries one.
- Skill text: when a reply has a `hint`, or the user's Tab already has several panes, prefer `--tab`; name the Tab after the task.
- Tests: each threshold, both directions, exactly at the limits.

### 15. Settings, demo, docs

**Done.** As built:

- Demo: no new commands are called (`tab_create` and `tab_update` were already mocked). The demo's `tab_create` now returns `spawnedByPane: null` and `userNamed: false`, as the real one does.
- `CLAUDE.md`: a Key Conventions entry. Only the Tab bar's rename passes `byUser`. `spawned_by_pane` marks a Spawned tab and is released when its owner closes. A Spawned tab is created through `createTab`'s `spawn` option, never by patching the layout afterwards. Also `crowding` is added to the `lib/agentControl/` line.
- Release notes draft: a fourth bullet, "Helpers get a room of their own".
- Verify: the Tabs item was added when this round was planned.

The original list:

- `lib/demo/mockInvoke.ts`: anything new the demo calls.
- `CLAUDE.md`: the Tab ownership columns and the user-named rule (an Agent never renames a Tab the user named).
- Release notes draft: one more bullet (Agents can open helpers in their own Tab and name Tabs).
- Verify (below): a Spawned tab survives a restart with its owner; the user renaming a Tab stops further Agent renames; a hint appears in a crowded Tab.

## Across Workspaces, and names for every Agent (third round: steps 16–20)

Agents reach every Workspace of their own Profile, and every Agent has a name ("Agent Two" by default). See ADR-0055, and **Agent control**, **Agent handle**, **Default handle**, **Spawned tab** and **Control badge** in `GLOSSARY.md`.

### Decisions

| Topic | Decision |
|-------|----------|
| Reach | Every Workspace of the caller's Profile, in any of its Windows. Never another Profile. Own Workspace by default. |
| Addressing | `--workspace <name>` on every command: matched exactly, ignoring case. Two Workspaces of that name: refused, listing them by folder. Handles are unique in the Profile, so `--workspace` is needed only for Pane numbers (and is allowed with handles). |
| Discovery | `abundio workspace list`: each Workspace of the Profile with name, folder, branch, whether it is open, and its Agents (handle, kind, pane). |
| Actions | Every command works in another Workspace. A new pane there (`pane split`, `agent start`, `tab new`) always gets a **Spawned tab**, owned by the caller, never a split. |
| Not opened | Opened for the call in the background, as the user would open it: panes spawn, Agents relaunch with Session resume, it joins the restore list, the user's view does not move. It stays open. A Missing folder is refused. |
| Badge | `← reviewer · api` when the caller is in another Workspace; unchanged within one. |
| Skill | Stay in your own Workspace unless the user names another or asks you to work across them. Never open a closed Workspace uninvited. |
| Names | Every Agent has an **Agent handle**: letters, digits, spaces, `-`, `_`, 1–32 characters, never Pane-number-like (`p3`, any case). Matched ignoring case, with a space and a dash treated alike. |
| Default names | A pane entering agent mode without a handle gets "Agent" + the lowest free number in words ("Agent One" … "Agent Twenty-One"), counted across the Profile. A number is free again once its Agent leaves its pane. User-chosen names that look like defaults are skipped. |
| Rename | Any time, from the pane menu or `agent rename`. Clearing a handle gives a default back. Every handle goes with its Agent when it leaves the pane, whoever chose it. |
| Uniqueness | In the Profile, checked by Rust against every layout of the Profile in the database (other Windows' copies can be stale). |

### 16. Handles become names

**Done.** As built:

- Rust: `normalize_handle` (the stored form, or none), `valid_handle` (already in stored form) and `handle_key`. TypeScript: `normalizeHandle`, `isValidHandle`, `handleKey`, `sameHandle`, `handleGrammarProblem` (the dialog's wording). Letters are ASCII. A key drops leading and trailing dashes, so "ab-" and "ab" are one handle.
- Both are tested against one table, `src/lib/__tests__/fixtures/handleGrammar.json`: Rust reads it with `include_str!`, Vitest imports it.
- `parse_target` takes `P3` as Pane 3 too, and stores a handle target in normalized form. `--handle` and `agent rename` store normalized names ("  Agent  Two " becomes "Agent Two").
- The Window resolves handles by key (`resolveTarget`), and `checkHandle` compares keys. Uniqueness is still per Workspace here; step 17 moves it to the Profile, in Rust.
- `setAgentHandle` normalizes before checking. The dialog's hint and placeholder follow the new grammar.
- Help explains matching and quoting.
- Tests: the shared table both sides, case and spacing matches, `P3`, a quoted handle as one argument, a capitalised rename.

The original list:

- Grammar, in Rust (`valid_handle`) and TypeScript (`lib/agentHandle.ts`) together: letters (any case), digits, spaces, `-`, `_`; trimmed; inner runs of spaces collapsed to one; 1–32 characters; must start with a letter; never `p` + digits in any case.
- `handle_key(name)`: the matching form, lowercased with every run of spaces and dashes made one `-`. "Agent Two", "agent-two" and "AGENT  two" share the key `agent-two`. Targets resolve by key; uniqueness is by key.
- `parse_target`: a Pane number (`p3`, any case) or else a handle. Handles with spaces arrive as one argv element when quoted; the help text and skill show the quotes.
- The pane menu dialog's checks and wording follow the new grammar.
- Tests: grammar both sides (the same table run in Rust and TS), keys, targets with spaces, Pane-number look-alikes refused in any case.

### 17. Default handles and Profile-wide uniqueness

**Done.** As built:

- `workspace_store`: `profile_of(workspace_id)` and `profile_handles(profile_id)`, which walks every Tab layout of the Profile in Rust and returns `(workspace id, workspace name, pane id, handle)`.
- New `agent_names.rs`:
  - `number_words` goes up to Nine Hundred Ninety-Nine, then digits. `default_handle(n)` gives "Agent " plus that. `lowest_free` skips any key in use, so a user's "agent two" takes Two.
  - `HandleReservations`: one mutex around reading what is taken and reserving, 10 s per reservation. A second ask for the same pane returns what it holds. A check by another pane sees reservations.
  - Commands `agent_handle_check` (answers `{ ok }` or `{ ok: false, code, message }`, naming the Workspace that holds the handle) and `agent_handle_default`.
- Frontend: `setAgentHandle` is now async. It runs the local check (grammar, this Workspace) and then Rust's Profile-wide one. If Rust cannot be asked (the browser demo), the local check stands. Clearing a handle assigns a default. `ensureDefaultHandle(paneId)` names an Agent pane (one with `agentId`, or in agent mode) that has none, and never overwrites a name set while it waited.
- The one trigger is `startAgentControl` (Profile windows): a `subscribeStatusChange` listener names every pane that enters agent mode without a handle. That covers typed, task, split and hook-detected launches, and Agents relaunching when a Workspace opens, so no load-time pass is needed. `agent start` also calls `ensureDefaultHandle` before replying, so the caller learns the name.
- The pane menu dialog says the name works across the Profile, and that leaving it empty gives a default name ("Use a default name").
- Tests: Rust for number words (joins, hundreds, past 999), every default being a valid handle, gaps and look-alikes, counting across the Profile and not across Profiles, reservations for concurrent asks, a number freed when its Agent is gone, Profile-wide checks by key, and the answer's JSON shape. Store for naming Agent panes (stamped or only in agent mode), leaving shells and named panes alone, a concurrent rename winning, refusal from Rust, the tidied name, clearing to a default, and the demo fallback.

The original list:

- `workspace_store`: `profile_handles(profile_id) -> Vec<(workspace_id, pane_id, handle)>`, read from every Tab layout of the Profile's Workspaces (layout JSON parsed in Rust, terminal nodes only).
- `number_words(n)` (pure, Rust): One … Ninety-Nine, then One Hundred and on; tests across the joins (Twenty, Twenty-One, Ninety-Nine, One Hundred).
- Commands:
  - `agent_handle_check(workspace_id, pane_id, handle)`: `ok`, or `handle_taken` naming the Workspace that has it, or `invalid_handle`.
  - `agent_handle_default(workspace_id, pane_id)`: the lowest free "Agent N" in the Profile. Rust holds a short reservation (pane → handle, in memory, under one mutex) until that pane's layout carries it or 10 s pass, so two Windows naming two new Agents at once never pick the same number.
- Frontend: `setAgentHandle` asks `agent_handle_check` before writing. `stampAgentOnPane` (and every other place a pane gains an Agent: typed launch, task launch, hook detection) calls `ensureDefaultHandle(paneId)`, which asks for a default when the pane has none. On Workspace load, agent panes without a handle get one. Clearing a handle (`agent rename <agent>` with no name, or an empty name in the dialog) assigns a default.
- The **Agent row**, title bar and Fleet tile already show the handle; with every Agent named, the row's first line is `Agent Two · <title>`.
- Tests: lowest free number with gaps, a user's "Agent Five" skipped, reservation across two concurrent asks, release when the Agent leaves, uniqueness across Workspaces of a Profile and not across Profiles, defaults on load.

### 18. Reach (Rust)

**Done.** As built:

- `split_workspace(argv)` takes `--workspace <name>` out of the command line, anywhere before `--`, ahead of `parse_args`. Every parser and its tests stay as they were (changed from the plan's `Parsed` field). Missing or blank value, or given twice: a usage error.
- `pick_workspace` (pure): an exact name ignoring case, among the caller's Profile's Workspaces only. None: `not_found`, listing the names. Several: `ambiguous_workspace`, listing their folders.
- `resolve_scope`: naming one's own Workspace is the same as not naming one. Another Workspace whose folder is gone: `folder_missing`. Otherwise its Window is read off any live PTY of it (`ControlTokens::window_for_workspace`). With none, it is not Opened, and the request goes to the caller's Window with `open: true`.
- `Scope { workspaceId, open }` travels on every `agent-control-request` as `target`, and `ask_window` sends to the scope's Window (resolve, wait and cancel included). The app log notes `target=<id>`, and `opening` when it is.
- `workspace list` (`Request::WorkspaceList`, read-only) is answered by Rust alone. For each Workspace: name, folder, `branch` (the last known), `open`, `self`, and its Agents (`pane`, `handle`, `agent`) from the layouts. Panes are numbered in tree order, as the Window numbers them.
- Help: the header says the reach is the Profile, explains `--workspace` and the cost of opening, and there is a `Workspaces:` group.
- The Window does not act in another Workspace until step 19: it answers such a call with `unsupported` rather than acting on its own Workspace.
- Tests: `--workspace` anywhere and not after `--`, its usage errors, picking (case, ambiguity, unknown, no prefix match), the Window from live PTYs, `workspace list` parsing and its listing from a real store (open flags, numbering), and the event's `target`.

The original list:

- `--workspace <name>`: accepted on every command, anywhere before `--`, parsed once at the top of `parse_args` into `Parsed::Request { workspace: Option<String>, request }`.
- Resolution, in Rust: the caller's Profile (from its Workspace) → its Workspaces in the database → the one whose name matches ignoring case. None: `not_found` listing the Profile's Workspace names. Several: `ambiguous_workspace` listing them by folder. A Missing folder: `folder_missing` (ADR-0053).
- Routing: the target Workspace's Window is found from the live control tokens (any PTY of that Workspace names its Window). With none, the target is not Opened, and the request goes to the caller's Window with `open: true`. The event gains `target: { workspaceId, open }`; `caller` is unchanged.
- `workspace list` is answered by Rust alone: Workspaces of the Profile (name, folder, last branch), `open` (any live PTY), and for each its Agents from the layouts (handle, `agentId`, Pane number).
- Help text: `--workspace` in the header and the `workspace` group.
- Tests: resolution (case, ambiguity, unknown, other Profile never matched, Missing folder), routing choice, `workspace list` shape, `--workspace` anywhere on the command line.

### 19. The Window: another Workspace

**Done.** As built:

- `runRequest(caller, request, signal, target)`. `loadScope` builds the `Scope` of the target Workspace: its panes and numbers, `home` (whether it is the caller's), `ownersElsewhere` (owners of its Spawned panes that sit in another Workspace, labelled `p2 · api`) and `callerName`, which is what the Control badge shows (`Agent One · home` when the caller is elsewhere).
- `open: true` → `openInBackground`: `markWorkspaceOpened` (the Fleet Console's way in: no activation, onto the restore list), then wait up to 30 s (`stalled`) until every terminal pane of it is mounted. A Missing folder is refused there too (`folder_missing`, new in the code union).
- In another Workspace, `pane split` and `agent start` (even without `--tab`) go through `openSpawnedTab` there, never `splitCaller`, and carry no `hint`. `openSpawnedTab` and `tab rename` act on the scope's Workspace. `tab rename` without `--tab` in another Workspace is `not_found` (the caller has no Tab of its own there). `pane current` always describes the caller's own pane.
- `describePane` takes `ownersElsewhere`.
- Release across Windows:
  - `closePane.releaseOwner(paneId)` frees `spawnedBy` in every Workspace **Opened in this Window**. It does not write others: this Window's copy of a Workspace another Window has open can be stale, and writing it back would undo that Window's edits.
  - The Tab rows' owner column is freed from any Window.
  - A closing pane announces itself through the new `agent_control_pane_closed` command, which broadcasts `agent-control-pane-closed`. Every Profile window runs `releaseOwner` when it hears it.
- The interim refusal from step 18 is gone.
- Tests: list, read (badge naming the caller's Workspace) and `pane current` across Workspaces; a split there becoming a Spawned tab with an owner labelled across Workspaces and the caller's layout untouched; `tab rename` needing `--tab` there; opening in the background (restore list, view and focus unchanged, call waits for mount), stalling, and a Missing folder; release telling every Window and never writing an un-Opened Workspace's layout.

The original list:

- `runRequest` takes the target Workspace (default: the caller's) for its `Scope`. Pane numbers and handles resolve there.
- `open: true`: `markWorkspaceOpened(id)` without activating, then wait (up to 30 s, else `stalled`) until that Workspace's terminals are mounted, before carrying out the call.
- New panes in another Workspace: `pane split`, `agent start` and `tab new` all go through `openSpawnedTab` there, owned by the caller; no `hint` (it is not the caller's Tab that is crowded).
- Ownership across Workspaces and Windows: `spawnedBy` in a description shows the owner as `p2 · api` when it is elsewhere. When a pane closes, its Window releases what it owns in its own Workspaces and Rust tells the Profile's other Windows (`agent-control-pane-closed { paneId }`, heard with `listenToThisWindow`). An owner id left in a Workspace no Window has open is inert: Pane ids are never reused.
- `tab rename --tab <pane> --workspace <name>`: the same rules; "own Tab" is only ever in the caller's Workspace.
- Control badge: `callerLabel` adds the caller's Workspace name when it is not the target's.
- Tests: calls into another Workspace (list, read, prompt), opening in the background (view and focus unchanged, call waits for mount, stall), new pane always a Spawned tab there, badge label, `spawnedBy` across Workspaces, release on owner close from another Window.

### 20. Skill, Settings, demo, docs

- Skill: the `--workspace` option and `workspace list`; stay home unless the user asks; never open a closed Workspace uninvited; quote handles with spaces (`"Agent Two"`).
- Settings ▸ Agents: the "Let agents control panes" description says Agents reach every Workspace of the Profile (it now says they never reach another Workspace).
- Demo: mock the new commands (`agent_handle_check`, `agent_handle_default`); `workspace list` never reaches the demo.
- `CLAUDE.md`: reach is the Profile; handles are unique in the Profile and checked in Rust; every Agent has a handle.
- Release notes draft: a bullet for cross-Workspace reach and one for default names.
- Verify (below): an Agent in one worktree prompts and waits on an Agent in another; a call into a closed Workspace opens it in the background with its Agents; two new Agents in two Windows at once get different default names; a handle with spaces works from the CLI.

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
- Tabs: an Agent opens a helper with `--tab`; the user's view stays put and the new Tab is at the end, named after the task. After a restart the Tab is still the Agent's to rename. Once the user renames it by hand, the Agent's `tab rename` is refused. In a Tab with four panes, `agent start` replies with a `hint`.
- Across Workspaces: from one worktree's Agent, `workspace list`, then `agent prompt "Agent One" "…" --wait --workspace <other>`; the other Workspace's pane shows `← … · <this>`. A call into a closed Workspace opens it in the background (its Agents relaunch, the user's view stays put) and it is still open after a restart.
- Default names: start Agents in two Windows of one Profile at the same moment; they get different names. Rename one to "Reviewer" in the pane menu and address it as `reviewer` from the CLI. Quit it: the name is gone and the next Agent there gets the lowest free default.
