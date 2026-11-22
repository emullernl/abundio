---
status: proposed
---

# Remote profiles live on a Host, reached over SSH, and can be joined into a local Profile

We want coding Agents to keep working on a server while the laptop is asleep or closed, and to see and use them from the desktop app when it is open. See `GLOSSARY.md`: **Host**, **Remote profile**, **Abundio server**, **Client**, **Joined profile**. Plan: `docs/plans/remote-hosts.md`.

We decided:

- **A whole Profile lives on one Host.** A Remote profile's Workspaces, PTYs, layouts, handles, notes, Attention flags, custom agents, Prompt actions and Environment Bundles are stored on its Host. Single Workspaces are never remote on their own. The Profile is the boundary Agent control already stops at (ADR-0055), so it stays the boundary of "which machine".
- **The Host runs a headless Abundio server.** It owns the PTYs and keeps running, tracking status and serving Agent control, while no Client is attached (ADR-0063). It runs until it is stopped. It holds any number of Remote profiles.
- **The desktop app reaches it over the user's own `ssh` program.** No port is opened and Abundio adds no authentication of its own: the user's SSH keys, agent, `~/.ssh/config`, jump hosts, hardware keys and 2FA decide who gets in. Desktop Rust keeps **one long-lived `ssh <host> abundio-server connect` per Host**, shared by every Window of the app; `connect` bridges the channel to the server's socket (Unix socket, `0600`; a named pipe on Windows), and Abundio's own protocol multiplexes requests, events and PTY streams inside it, each Window with its own Client id. No `ControlMaster` is needed, so a Windows desktop works too, and it works where SSH port forwarding is disabled.
- **SSH prompts are answered in an Abundio dialog.** `ssh` runs with `SSH_ASKPASS` (and `SSH_ASKPASS_REQUIRE=force`) pointing at a small Abundio helper, which shows the password, passphrase, 2FA or new-host-key prompt (with fingerprint). At app start connections try `BatchMode` first and show "Sign in needed" instead of prompting.
- **The webview never touches the connection.** Desktop Rust splits the stream and pushes each Window's traffic into a Tauri Channel as raw bytes; local PTYs move to the same Channel, so base64 events go away for both.
- **The app installs and updates the server itself.** It downloads the server build for its own version from the GitHub release, checks its signature with the updater key, caches it, and uploads it over the SSH connection to `~/.abundio-server/<version>/`. The server's version always equals the app's. A newer app asks before updating a Host with live Agents, then restarts the server; Agents come back through Session resume (ADR-0050), plain shells are lost. An older or newer server is never spoken to.
- **The server keeps itself running with the Host's own service manager**: a `systemd --user` unit on Linux (linger offered for reboots), a per-user LaunchAgent on macOS (a LaunchDaemon offered for start without login), a Scheduled Task at logon on Windows. With none of these it runs as a detached process and the checklist says it will not survive a reboot.
  - **Update (phase 11): macOS Hosts are left out for now.** A server run over SSH on a Mac fights macOS: an SSH session cannot open the login Keychain (where Claude Code and gh keep their logins), Desktop, Documents and Downloads need Full Disk Access granted on the Mac, and a LaunchAgent only comes back once someone logs in, while a LaunchDaemon runs with no Keychain at all. Most Hosts are Linux machines, so Host setup refuses a Mac ("macOS Hosts aren't supported yet") and no macOS server is released. The server still builds and runs on macOS, because the tests and development reach one on this computer without SSH. Uninstall still removes a LaunchAgent an earlier development build set up.
- **A local Profile may join Remote profiles; joining is a view.** The Window shows each Joined profile in its own section of the Workspace and Agents lists, marked with its Host, and in every other view (Fleet Console, Navigator, cycles, quick-open, badge). Agents never reach across a join, so a remote Agent never depends on the laptop being awake. A Remote profile may also be a Window's Active profile.
- **Several Clients may show one Remote profile at once.** Workspaces, Tabs, layouts, Opened workspaces, handles, notes and Attention flags are shared through the server; the Active workspace, Focused pane, panels, sidebar widths and unsaved File pane edits are each Client's own. The Client that last typed in, focused or resized a pane sets its PTY size.
- **First release: Linux (x86_64 and arm64, static) and macOS Hosts.** Windows Hosts follow once the protocol has settled.

## Considered Options

- **Remote Workspaces inside a local Profile** (one Profile spread over machines). Rejected: Agent control, handles and the Orchestrator would span machines and stall whenever the laptop sleeps. Joining gives the same view without that.
- **Direct TLS with a pairing token**, or relying on Tailscale/VPN. Rejected: we would own certificates, exposure and auth. SSH is already set up on every server the user can reach.
- **A built-in Rust SSH client (`russh`).** Rejected: we would re-implement config parsing, jump hosts, agent forwarding and hardware keys, and users would hit setups we don't cover.
- **One SSH connection per Window.** Rejected: more logins and 2FA prompts, and two Windows of one computer would look like two strangers to the server.
- **A localhost WebSocket the webview opens itself.** Rejected: a local port other processes could reach, and a second auth to get right.
- **A package (apt, rpm, tarball) the user installs.** Rejected: friction and version skew. Uploading over SSH needs no root and no internet on the server.
- **A separate, long-lived PTY keeper** (like tmux) so an upgrade never kills a PTY. Rejected for now: a second program with its own frozen protocol. Session resume covers Agents; shells are lost on upgrade, after the user agrees.
- **Server speaks several protocol versions.** Rejected: every change would need a compatibility path.
- **A local Rust proxy forwarding each command.** Rejected: about 160 commands would each need a forwarding path, and events would be relayed twice. The frontend picks the backend instead (`docs/plans/remote-hosts.md`, step 4).

## Consequences

- One Window talks to several backends at once (this computer and each joined Host). Every IPC call and event is routed by the Workspace's Host, and every frontend store keyed by Workspace or pane must tell Hosts apart.
- "A Profile is bound to at most one Window" now holds only for local Profiles.
- Things that act on the desktop's own files (Reveal in Finder, open with the default app) are hidden for remote Workspaces. Open in IDE uses VS Code / Cursor Remote-SSH.
- On a headless Host the OS keyring is usually missing or locked, so the Environment Bundle master key falls back to a `0600` key file in the server's data folder.
- A macOS Host's privacy protection (TCC) silently blocks a headless Agent from Documents, Desktop and Downloads unless the server is granted Full Disk Access. The setup checklist warns.
- Each release must build and sign server programs for every Host platform, which needs the updater signing key set up.
