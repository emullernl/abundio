---
status: proposed
---

# Pane status, Agent control and layouts move into Rust

ADR-0054 kept the status machine (`statusReducer.ts`), the pane tree and Agent control in the Window, and rejected moving them to Rust because "a call only matters while its Workspace is Opened, and then its Window exists". Remote profiles (ADR-0062) break that premise: the point of an Abundio server is that Agents keep working, and the Orchestrator keeps prompting helpers, while no Window exists. Several Clients may also show one Remote profile, so no single Window can own its layout.

We decided:

- **Rust owns pane status.** Hook events, title rules and PTY activity feed a Rust status machine; Windows receive status changes as events and only draw them. Attention flags, Progress lines and the Attention count live there too.
- **Rust owns the layout.** The pane tree, Tabs and Opened workspaces are edited in Rust and broadcast to every Client; a Window sends edits, it no longer writes layout JSON itself.
- **Rust carries out Agent control.** `handleControlRequest.ts` and its helpers (`resolveTarget`, `settle`, `spawn`, `watchLines`, notes ops…) move into the backend.
- **Every PTY has a Rust terminal emulator, `alacritty_terminal`**, fed by the PTY reader thread, locally as well as on a Host. Reading a pane's text (`pane read`, `pane watch`, the autosuggestion trim `readBuffer.ts` does today) reads this emulator, never xterm.js, because the PTY log's raw bytes come out garbled (ADR-0054) and there may be no xterm.js at all. Its scrollback length follows the terminal scrollback setting, so an Agent reads the same lines the user can scroll to.
- **The emulator is also what a Client is given on attach.** A Client that attaches or reconnects gets the screen and scrollback serialized from it, then live bytes, instead of a replay of the whole PTY log. A Client that falls behind (more than a bounded buffer per pane) has its queued bytes dropped and gets a fresh snapshot; the PTY is never slowed for a Client.
- **One implementation for every Profile.** Local Profiles use the same Rust code, not a TypeScript twin, so the trickiest logic cannot drift between local and remote.

ADR-0054's per-pane token, thin `abundio` client, "nothing asks first" and the Control badge are unchanged. Only "the Window carries out every call" is replaced.

## Considered Options

- **Keep the TypeScript for local Profiles, add a Rust copy for the server.** Rejected: two copies of the status machine and Agent control, kept in step forever.
- **Agent control refused while no Client is attached.** Rejected: an Orchestrator working overnight is the main use of a Remote profile.
- **Run the full frontend headless on the server** (a webview under a virtual display). Rejected: heavy, fragile, and it still leaves several Clients with no single owner.
- **`vt100` or `termwiz` as the emulator.** `vt100` is lighter but has no reflow and thinner escape support, so its text would differ from the screen more often; `termwiz` is complete but tied to WezTerm's internals. `alacritty_terminal` is already run headless this way by other editors.
- **Read xterm.js locally, the emulator only on a Host.** Rejected: two ways to read a pane that can disagree.
- **Replay the PTY log on attach.** Rejected: slow for long logs, and a TUI replays hours of redraws.
- **Throttle the PTY when a Client is slow.** Rejected: a remote Agent's build would wait on the user's Wi-Fi.

## Consequences

- This is the largest step of the remote work and lands first, for local Profiles alone, so it can ship and settle before any Host exists.
- Text read back by `pane read` / `pane watch` comes from the Rust emulator, not xterm.js; the two must agree on what the screen shows. Every byte is parsed twice on the desktop (Rust and xterm.js), which is cheap next to drawing.
- A Client that skipped ahead never sees the output it skipped; it is still in the PTY log and the emulator's scrollback.
