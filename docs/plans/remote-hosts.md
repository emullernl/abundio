# Remote Hosts

Run Abundio's backend on a server (a **Host**) so Agents keep working while the laptop is closed, and show those Workspaces and Agents in the desktop app. See `GLOSSARY.md` (**Host**, **Remote profile**, **Abundio server**, **Client**, **Joined profile**), ADR-0062 and ADR-0063.

## Why

Today every PTY is a child of the desktop app, so closing the laptop stops every Agent. Long Agent runs and the Orchestrator are most useful exactly when nobody is watching.

## Decisions (from the design session)

| Topic | Decision |
|-------|----------|
| Main goal | Agents keep running, with correct status and working Agent control, while no Client is attached. |
| Unit that is remote | A whole Profile. Every Profile lives on exactly one Host, fixed when it is made. |
| Profiles per server | Any number; the server has its own Profile registry and database. |
| Transport | The user's own `ssh`. Each connection runs `abundio-server connect`, which bridges stdio to the server's `0600` Unix socket (named pipe on Windows). No open port, no Abundio auth. |
| Server lifetime | Runs until stopped from the app or the Host reboots. Comes back after a reboot where the service manager allows. |
| Install | By the app, over SSH (see "Host setup"). No root, no package. |
| Server binary | Downloaded on demand from the GitHub release for the app's own version, signature checked with the updater key, cached, uploaded. |
| Versions | Server version always equals app version. Mismatch: Client refuses to connect and offers Update. |
| Upgrade with live Agents | Ask; restart the server; Agents relaunch by session id (ADR-0050); plain shells are lost. |
| Headless | Server runs PTYs, the status machine, Attention flags and Agent control itself (ADR-0063). |
| Same code locally | Yes. Local Profiles move to the same Rust status/control/layout code. |
| Several Clients | Yes, same user. Shared: Workspaces, Tabs, layouts, Opened workspaces, handles, notes, Attention flags. Per Client: Active workspace, Focused pane, panels, sidebar widths, Fleet Console/Orchestrator view open, unsaved edits. |
| PTY size with two Clients | The Client that last typed in, focused or resized the pane decides. |
| Disconnect | Panes freeze read-only with a "Reconnecting to <host>…" banner. Keystrokes are dropped, never queued. Auto-reconnect with backoff; panes catch up from the server's scrollback. |
| Alerts while away | None pushed. On reconnect: correct badge and icons, plus one summary notification. |
| Joining | A local Profile can join Remote profiles; view only. Agent control never crosses a join. |
| Workspace list | One section per Joined profile: `☁ <host> · <Profile>` with a connection dot. Agents list groups follow, with the Host chip. |
| Handle clash in lists | Remote Agents always carry the ☁ chip; a clashing name reads `Agent Two @ build-box`. Handles stay per Profile. |
| Other views | Fleet Console, Navigator, Workspace cycle, Agent cycle, File quickopen and the app badge include joined Workspaces, marked. The Orchestrator view button stays the local Profile's; a Host's Orchestrator opens from its section's ⋯ menu. |
| Join entry | "+ Join remote profile…" at the bottom of the Workspace list; Add Host's last step offers "Join into <current Profile>". "Leave" in the section menu only hides it. |
| New workspace | Location picker in the dialog: This Mac or a Joined profile; the folder picker then browses that Host. |
| At launch | Joined profiles reconnect in the background. SSH needing a password/2FA shows "Sign in needed" in the section, never a prompt at startup. |
| Host unreachable | Section keeps last known rows, greyed, "last seen …"; statuses shown as unknown. |
| Per-Host settings | Custom agents and Prompt actions live in the Host's database. Appearance, Keymap, fonts stay global on the desktop. |
| Secrets | Env Bundle master key: OS keyring if usable, else a `0600` key file in the server's data folder (DPAPI on Windows). |
| Desktop-only actions | Open in IDE uses VS Code/Cursor Remote-SSH. Reveal in Finder / open with default app are hidden for remote Workspaces. Cmd/Ctrl+click a path opens Abundio's own File pane. |
| Agents on the Host | Setup checklist; "Install in a pane" opens a Host terminal with the official install command typed, not run. Login happens there. |
| Platforms, v1 | Linux x86_64 + arm64 (static musl), macOS universal. Windows Hosts in a later release. |
| v1 features | Everything: panes and Agents, git/Explorer/Search/editor, Orchestrator, Fleet Console, several Clients. |

## Host setup (what the app does)

1. **Settings ▸ Hosts ▸ Add Host**: pick a `~/.ssh/config` alias or type `user@host`.
2. One multiplexed `ssh` connection (ControlMaster on Unix) carries every step.
3. **Probe**: OS and CPU (`uname -sm`; PowerShell on Windows), home folder writable, installed server versions, service manager (`systemd --user`, linger; `launchctl`; Task Scheduler), Agents, `git`, `gh`.
4. **Checklist** with a ✓ or a fix per line: platform, server installed and current, survives reboot, Agents found, `git`, `gh` signed in, (macOS) Full Disk Access.
5. **Install**: stream the cached binary over the connection to `~/.abundio-server/<version>/abundio-server`, verify its checksum, `chmod +x`, point `current` at it atomically.
6. **Start**:
   - Linux: write a `systemd --user` unit, `enable --now`. Try `loginctl enable-linger`; if refused, show the one `sudo` command. Without systemd: `setsid`/`nohup`, and say it won't survive a reboot.
   - macOS: per-user LaunchAgent (`launchctl bootstrap gui/<uid>`, or `user/<uid>` over SSH). Offer "Start at boot without login" as a LaunchDaemon via one `sudo` command.
   - Windows (later): Scheduled Task at logon; offer "run at startup" (stores the password with Task Scheduler).
7. **Connect** and list the Host's Profiles; offer "Create Profile" and "Join into <current Profile>".
8. **Update**: same path for a new version; ask first if Agents are live. **Remove Host**: stop the service, delete `~/.abundio-server`.

## Steps (ordered commits on one branch)

Back up `abundio.db` (+ `-wal`, `-shm`) before running any step with a migration.

### 1. Status machine, layouts and Agent control into Rust (local only)

ADR-0063. Ships on its own, for local Profiles; behaviour unchanged for the user.

- Port `statusReducer.ts` and the hook/title/activity inputs to a Rust status machine; emit status changes; frontend status code becomes a reader. Keep the shared table tests by running the same fixtures in both languages during the move, then delete the TS reducer.
- Move Attention flags, Progress lines and the Attention count into Rust.
- Move pane-tree editing (`paneTree.ts` operations used by stores and Agent control) into Rust; layouts are edited by command and broadcast; the Window applies broadcasts.
- Add a headless VT emulator per PTY (fed from the PTY reader thread) for `pane read` / `pane watch` / prompt detection.
- Move `lib/agentControl/*` into Rust; `agent-control-request` round-trip to the Window goes away except for UI-only effects (focus, File window open), which become events to the Window that should act.
- Tests: the existing TS tests' cases re-expressed in Rust; settle/wait, cycles, spawn, close refusals.

### 2. Split the crate: core library, desktop app, server

- New workspace crates: `abundio-core` (PTY manager, stores, git, search, explorer, status, control, layout), `abundio-desktop` (Tauri), `abundio-server` (headless binary).
- Replace `AppHandle`/`emit` in core with an `EventSink` trait; replace window-label keys (`owner_map`, git scheduler, file watcher, search progress, profile ownership) with a `ClientId` (a Window locally, a connection remotely).
- Hook server, relay scripts, shell integration, `abundio` CLI and the skill are written under the Host's data folder by core.
- `env_crypto`: key-file fallback when the keyring is unavailable.

### 3. Server protocol

- One framed, versioned message protocol over a byte stream: request/response (command name + JSON args), subscriptions, server-pushed events (PTY output batches, status, layout broadcasts, signals).
- Server side: socket listener, `connect` stdio bridge, per-Client subscriptions, last-actor PTY sizing, scrollback catch-up from `pty-logs` on reconnect.
- Version handshake: exact match or refuse.

### 4. Frontend transport switch

- Move the ~22 files that import Tauri directly (`invoke`, `event`, `plugin-*`, `api/path`) behind `lib/ipc.ts`.
- Label every command **host** (goes to the Workspace's Host) or **desktop** (always local: windows, placement, badge, notifications, clipboard, dialogs, updater, File window chrome).
- `ipc.ts` routes host commands by the Workspace's Host: local Rust, or a WebSocket-like channel the desktop opens through SSH (desktop Rust runs `ssh` and relays bytes; the webview never spawns processes).
- Stores keyed by Workspace or pane id carry the Host where ids could clash.

### 5. Hosts in the desktop app

- Settings ▸ Hosts: Add / Update / Remove, the checklist, server status.
- Desktop Rust: `ssh` process management, ControlMaster, binary cache, download + signature check, upload, service install per platform.
- Reconnect loop with backoff; "Sign in needed" when SSH would prompt (`BatchMode=yes` first, then an interactive pane-less sign-in).

### 6. Joined profiles and remote UI

- Local Profile's list of Joined profiles (desktop DB).
- Workspace list and Agents list sections, Host chip, `@ host` on clashes, greyed offline rows with "last seen".
- Fleet Console, Navigator, cycles, quick-open and badge include joined Workspaces.
- Host Orchestrator from the section menu; New Workspace Location picker with remote folder browsing.
- Freeze + reconnect banner; dropped-input rule; update prompt.
- Remote-SSH IDE links; hide Reveal in Finder and default-app open.

### 7. Several Clients

- Shared vs per-Client state split as in the table; per-Client view state stays in the Window.
- Two-Client tests: layout edit on one appears on the other; resize follows the last actor.

### 8. Release

- CI builds and signs `abundio-server` for linux-x86_64-musl, linux-aarch64-musl, macOS universal; attaches to the release with checksums.
- Needs the updater signing key set up first.

### Later: Windows Hosts

PowerShell probe and install steps, Scheduled Task, named pipe, DPAPI, path rules (drive letters, case-insensitive folders), shell integration on PowerShell; New task refused unless the shell is bash/zsh.

## Open risks

- Step 1 is large and touches the most-tested logic in the app; land it in several commits, each green.
- The Rust VT emulator and xterm.js must agree on screen text closely enough for `pane watch` and prompt detection.
- Keystroke latency over SSH is the network's; nothing hides it.
