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
| Transport | The system `ssh` program, spawned by desktop Rust. One long-lived `ssh <host> abundio-server connect` per Host, shared by all Windows; `connect` bridges stdio to the server's `0600` Unix socket (named pipe on Windows). Our protocol multiplexes everything inside it; each Window has its own Client id. No ControlMaster, no open port, no Abundio auth. |
| SSH prompts | `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` → an Abundio helper dialog (password, passphrase, 2FA, new host key with fingerprint). `BatchMode` at app start; "Sign in needed" on failure. |
| To the webview | Desktop Rust demultiplexes into a per-Window Tauri Channel, raw bytes. Local PTYs move to the same Channel (no more base64 events). |
| Pane text without a Window | `alacritty_terminal` emulator per PTY in Rust, locally too. Agent control reads only it. Scrollback length follows the terminal setting. |
| Attach / reconnect | Snapshot (screen + scrollback) from the emulator, then live bytes. |
| Slow Client | Bounded buffer per Client per pane (~1 MB); past it, drop and send a fresh snapshot. The PTY is never throttled. |
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
2. Setup runs a few short `ssh` calls (prompts through the askpass dialog); once the server runs, the one long-lived connection carries everything.
3. **Probe**: OS and CPU (`uname -sm`; PowerShell on Windows), home folder writable, installed server versions, service manager (`systemd --user`, linger; `launchctl`; Task Scheduler), Agents, `git`, `gh`.
4. **Checklist** with a ✓ or a fix per line: platform, server installed and current, survives reboot, Agents found, `git`, `gh` signed in, (macOS) Full Disk Access.
5. **Install**: stream the cached binary over the connection to `~/.abundio-server/<version>/abundio-server`, verify its checksum, `chmod +x`, point `current` at it atomically.
6. **Start**:
   - Linux: write a `systemd --user` unit, `enable --now`. Try `loginctl enable-linger`; if refused, show the one `sudo` command. Without systemd: `setsid`/`nohup`, and say it won't survive a reboot.
   - macOS: per-user LaunchAgent (`launchctl bootstrap gui/<uid>`, or `user/<uid>` over SSH). Offer "Start at boot without login" as a LaunchDaemon via one `sudo` command.
   - Windows (later): Scheduled Task at logon; offer "run at startup" (stores the password with Task Scheduler).
7. **Connect** and list the Host's Profiles; offer "Create Profile" and "Join into <current Profile>".
8. **Update**: same path for a new version; ask first if Agents are live. **Remove Host**: stop the service, delete `~/.abundio-server`.

## Phases (ordered commits on one branch, `feat/remote-hosts`)

Everything lands on this one branch, as ordered commits; rebase on `main` often, since it will live for months. The app stays working after every phase. The remote feature is visible in dev builds only (`import.meta.env.DEV` / a Rust `cfg(debug_assertions)` gate) until phase 11 removes the gate.

Back up `abundio.db` (+ `-wal`, `-shm`) before running any phase with a migration.

### Part A: the logic moves into Rust (local only, no visible change)

#### 1. Groundwork

- Move the ~22 files that import Tauri directly (`invoke`, `event`, `plugin-*`, `api/path`) behind `lib/ipc.ts`.
- Label every command **host** (goes to the Workspace's Host) or **desktop** (always local: windows, placement, badge, notifications, clipboard, dialogs, updater, File window chrome).
- Rust: an `EventSink` trait in place of `AppHandle`/`emit` in core modules; a `ClientId` in place of window-label keys (`owner_map`, git scheduler, file watcher, search progress, profile ownership).
- PTY output over a per-Window Tauri Channel as raw bytes; drop the base64 `pty-output-*` events and update the CLAUDE.md convention.

#### 2. Rust emulator, shadow mode

- `alacritty_terminal` per PTY, fed by the PTY reader thread; scrollback from the terminal setting. It never draws.
- Port `readBuffer.ts`'s rules (wrapped lines, autosuggestion trim) and `watchLines`.
- **Shadow mode (dev builds):** every `pane read` / `pane watch` computes both and logs any difference. Shared fixtures of recorded PTY output (Claude Code, Codex, a shell with autosuggestions, an alt-screen TUI) in both test suites.
- Switch Agent control's reads to Rust once the logs are quiet; delete the xterm.js read path.

#### 3. Status machine into Rust, shadow mode

Done in three steps: **3a** the reducer ported (`status_machine.rs`, parity fixture from random event sequences); **3b** a Rust status store mirrored in shadow mode (dev builds), quiet in real use; **3c** Rust the authority with the Window predicting (`status_apply`, `status-updates`), the idle scan only in Rust. Event sources (hooks, PTY exit, title, shell integration) still start in the Window; they move into Rust with the server (phase 6), so a Host keeps status with no Window. The TypeScript reducer stays as the Window's prediction and the tests' reference.


- Port `statusReducer.ts`, the hook inputs, title rules (`agentTitleMap.ts`) and PTY activity. Attention flags, Progress lines and the Attention count move with it.
- **Shadow mode (dev builds):** both machines run on every input; disagreements are logged with the input sequence. Verify in the real app for each Agent, auto-launch and manual paths (not just tests).
- Switch the frontend to read Rust's status events; delete the TS reducer.

#### 4. Layouts owned by Rust

Done in steps: **4a** layout edits as node-level ops (`set` / `replace` / `patch`, keyed by node id), computed by diffing the Window's old and new tree (`layoutOps.ts`) and applied the same in Rust (`layout_ops.rs`, `fixtures/layoutOps.json`); none of `paneTree.ts`'s edit functions needs a Rust twin, and edits to different panes from two Clients both land. **4b** Rust the authority for every Tab's layout (`layout_store.rs`, `layout_apply`): it applies, saves, numbers (in memory, so no migration) and sends `layout-changed` to the Profile's other Windows; the Window predicts (`layoutSync.ts`) and takes Rust's answer when it differs. A Tab's first edit in a Window is sent whole. Still Window-only: a newly spawned PTY's id is written into the layout locally and reaches Rust with the next edit; a Host Client attaching to live PTYs (phase 7) needs it sent at once.

- Pane-tree edits (`paneTree.ts` operations used by stores and Agent control) become Rust commands; Rust saves and broadcasts; Windows apply broadcasts.
- Split shared state (layouts, Tabs, Opened workspaces, handles, notes) from per-Window view state (Active workspace, Focused pane, panels).

#### 5. Agent control into Rust

- Needs 2–4. Move `lib/agentControl/*` into Rust; the `agent-control-request` round-trip goes away except for UI-only effects (focus, File window open), which become events to the Window that should act.
- Port the TS tests' cases to Rust: settle/wait, cycles, spawn, close refusals, notes ops.

**Checkpoint:** the local app behaves exactly as before, with status, layout and Agent control in Rust. Full manual pass over Agents, Orchestrator, Fleet Console before Part B.

### Part B: the remote path (dev builds only)

#### 6. Crate split and headless server

- Workspace crates: `abundio-core`, `abundio-desktop` (Tauri), `abundio-server`.
- Hook server, relay scripts, shell integration, `abundio` CLI and the skill written under the Host's data folder by core.
- `env_crypto`: key-file fallback when no keyring is usable.
- Run the server on this Mac and reach it with `ssh localhost`, so the whole remote path is tested before any real server.

#### 7. Protocol, connection, routing: a Remote profile as Active profile

- Framed, versioned protocol over a byte stream: requests, subscriptions, pushed events (PTY bytes, status, layout broadcasts, signals). Exact-version handshake.
- Server: socket (`0600`), `connect` stdio bridge, emulator snapshot on attach.
- Desktop: one `ssh <host> abundio-server connect` per Host, askpass helper + dialog, `BatchMode` at start, reconnect with backoff, `ServerAliveInterval`.
- `ipc.ts` routes host commands by Host; stores keyed by Workspace/pane tell Hosts apart.
- A Window can make a Remote profile its Active profile, one Client. Freeze + reconnect banner; dropped-input rule.

#### 8. Host setup

- Settings ▸ Hosts: Add / Update / Remove, the checklist, server status (see "Host setup").
- Binary download + signature check + cache, upload, `systemd --user` (+ linger), LaunchAgent, detached fallback; update prompt with live Agents.
- CI builds and signs `abundio-server` for linux-x86_64-musl, linux-aarch64-musl, macOS universal. Needs the updater signing key set up first.

#### 9. Several Clients

- Shared state broadcast to every Client; per-Client view state stays in the Window.
- Last-actor PTY sizing; bounded per-Client buffers with skip-ahead snapshots.
- Two-Client tests: a layout edit on one appears on the other; resize follows the last actor; a slow Client skips ahead.

#### 10. Joined profiles

- A local Profile's list of Joined profiles (desktop DB); "+ Join remote profile…", Add Host's last step, "Leave".
- Workspace list and Agents list sections, Host chip, `@ host` on clashes, greyed offline rows with "last seen", background reconnect with "Sign in needed".
- Fleet Console, Navigator, cycles, quick-open and the badge include joined Workspaces.
- Host Orchestrator from the section menu; New Workspace Location picker with remote folder browsing.
- Remote-SSH IDE links; hide Reveal in Finder and default-app open.

#### 11. macOS Host polish, then open it up

- TCC / Full Disk Access check in the checklist; LaunchDaemon option.
- Remove the dev-build gate; the feature ships.

### Later: Windows Hosts

PowerShell probe and install steps, Scheduled Task, named pipe, DPAPI, path rules (drive letters, case-insensitive folders), shell integration on PowerShell; New task refused unless the shell is bash/zsh.

## Open risks

- Part A is large and touches the most-tested logic in the app; land each phase in several commits, each green, with shadow mode before every switch.
- One branch for months: rebase on `main` often, or conflicts in `ipc.ts`, stores and `commands.rs` pile up.
- The Rust VT emulator and xterm.js must agree on screen text closely enough for `pane watch` and prompt detection.
- Keystroke latency over SSH is the network's; nothing hides it.
