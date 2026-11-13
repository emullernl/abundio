---
status: accepted, amended by ADR-0055 (reach is the whole Profile)
---

# Agent control runs in the Window and trusts a per-pane token

> **Update: amended by ADR-0055.** An Agent now reaches every Workspace of its own Profile, not only its own Workspace, and every Agent has a handle. The per-pane token, the Window carrying out each call and the thin client below are unchanged; "reaches only its own Workspace" now reads "reaches only its own Profile".

**Agent control** lets an Agent in one Pane drive other Panes of its Workspace through the `abundio` command: list Panes and Agents, read a Pane's text, prompt an Agent and wait for it to **settle**, start an Agent in a new Pane, send keys, and run a command in an idle shell. Two facts about the app shape how it works:

- The only channel from a process inside a PTY back to the app is the local hook server (`hook_server.rs`, loopback HTTP). Its token is the same in every PTY, so a request cannot prove which Pane sent it. `hook_server.rs` says so: it is not a boundary between Panes.
- Pane layout and Agent status live only in the Window's frontend (`paneTree.ts`, `workspaceStore`, the status machine in `statusReducer.ts`). Rust stores layout JSON but never edits it, and it does not know any Pane's status.

We decided:

- **Each PTY gets its own Agent control token.** It is created at spawn, given to the PTY as `ABUNDIO_AGENT_TOKEN`, and revoked when the PTY exits. Rust maps it to the PTY, its Pane, its Workspace and its Window. A request's caller is whatever its token says, never what the request body claims. This is what makes the two rules real: only a process inside one of the app's own Panes can call, and it reaches only its own Workspace. The shared hook token is unchanged and keeps serving hooks and `abundio-env`.
- **The Window carries out every call; Rust only checks and routes.** Rust checks the token, the Workspace limit and the setting, then sends the request to the Window that owns the Workspace and returns that Window's answer. The layout and status code stays in one place. If the Window is gone, the call fails cleanly.
- **The `abundio` command is a thin client.** It sends its own arguments, unparsed, to the hook server and prints the answer. Rust parses the arguments, writes the help text and formats the JSON, so the shell script and its PowerShell twin stay a few lines long and cannot drift from the server.
- **Nothing asks the user first.** A **Control badge** on the target Pane shows a call while it runs, and every call is written to the app log. Agents can therefore keep working while the user is away. One app-wide setting turns Agent control off.

## Considered Options

- **Reuse the shared hook token.** Rejected: any Pane could pretend to be any other, so the Workspace limit would only be a convention.
- **A new Unix socket.** Rejected: Windows would need a different mechanism, and it would still need a per-pane token to know which Pane is calling.
- **Move status and layout to Rust**, so calls would not need a live Window. Rejected: it means rewriting the status machine and the pane-tree code, with two owners during the move. A call only matters while its Workspace is Opened, and then its Window exists.
- **Read Pane text from the PTY log in Rust.** Rejected: it holds raw bytes, and full-screen Agent interfaces redraw constantly, so cleaned-up text comes out garbled. The Window's terminal buffer has the text as drawn.
- **Ask the user before risky actions** (send-keys, run, close). Rejected: it blocks unattended work, which is the point of the feature. Closing is limited instead: an Agent closes only its own **Spawned panes**.
- **Parse arguments in the shell script.** Rejected: two scripts (sh and PowerShell) would each need to quote JSON and keep in step with every new command.

## Consequences

- Waits can last up to 30 minutes by default. The hook server's accept loop handles requests one at a time, so every Agent control request runs on its own thread, and a long wait never delays a hook.
- `prompt --wait` is two requests, a prompt and then a wait. If the connection drops during the wait (sleep, the server rebinding its port), the CLI retries only the wait, so a prompt is never sent twice.
- Rust keeps the graph of who is waiting on whom, because every wait passes through it. A wait that would close a loop is refused before it reaches a Window.
- **The token reaches every process in the pane, not only the Agent.** It is in the environment of whatever the pane runs: a package's install script, a test runner, a `make` target from a cloned repository. Any of them can do what an Agent can: run a command in an idle shell, send keys, or prompt another Agent (which may be allowed to act without asking), in every Workspace of the Profile (ADR-0055). Before this feature, a compromised process reached only its own pane. The setting is on by default; the user can turn it off in Settings ▸ Agents, and its description says this. Narrower defaults (on only for agent-mode panes, or `pane run` and `send-keys` only into the caller's own Spawned panes) were left open for a later decision.
- **It can get around an Agent's own permission prompts.** An Agent whose CLI asks before each shell command (Claude Code's per-command approval, Codex's approval policy) can send the same command to an idle shell with `abundio pane run`, or type it with `agent send-keys`, and the only prompt it meets is the one for `abundio` itself, which users soon allow for good. A prompt-injected Agent can do the same. The `agents_only` limit (ADR-0056) does not cover `pane run` or `send-keys`. The narrower defaults above are the remedy, still left for a later decision.
- A PTY spawned before this change has no Agent control token. That never happens after an upgrade, because quitting the app ends every PTY.
