---
status: proposed
---

# Pane status, Agent control and layouts move into Rust

ADR-0054 kept the status machine (`statusReducer.ts`), the pane tree and Agent control in the Window, and rejected moving them to Rust because "a call only matters while its Workspace is Opened, and then its Window exists". Remote profiles (ADR-0062) break that premise: the point of an Abundio server is that Agents keep working, and the Orchestrator keeps prompting helpers, while no Window exists. Several Clients may also show one Remote profile, so no single Window can own its layout.

We decided:

- **Rust owns pane status.** Hook events, title rules and PTY activity feed a Rust status machine; Windows receive status changes as events and only draw them. Attention flags, Progress lines and the Attention count live there too.
- **Rust owns the layout.** The pane tree, Tabs and Opened workspaces are edited in Rust and broadcast to every Client; a Window sends edits, it no longer writes layout JSON itself.
- **Rust carries out Agent control.** `handleControlRequest.ts` and its helpers (`resolveTarget`, `settle`, `spawn`, `watchLines`, notes ops…) move into the backend. Reading a pane's text uses a terminal emulator in Rust (a headless VT parser kept per PTY), since the PTY log's raw bytes come out garbled (ADR-0054).
- **One implementation for every Profile.** Local Profiles use the same Rust code, not a TypeScript twin, so the trickiest logic cannot drift between local and remote.

ADR-0054's per-pane token, thin `abundio` client, "nothing asks first" and the Control badge are unchanged. Only "the Window carries out every call" is replaced.

## Considered Options

- **Keep the TypeScript for local Profiles, add a Rust copy for the server.** Rejected: two copies of the status machine and Agent control, kept in step forever.
- **Agent control refused while no Client is attached.** Rejected: an Orchestrator working overnight is the main use of a Remote profile.
- **Run the full frontend headless on the server** (a webview under a virtual display). Rejected: heavy, fragile, and it still leaves several Clients with no single owner.

## Consequences

- This is the largest step of the remote work and lands first, for local Profiles alone, so it can ship and settle before any Host exists.
- Text read back by `pane read` / `pane watch` comes from the Rust emulator, not xterm.js; the two must agree on what the screen shows.
