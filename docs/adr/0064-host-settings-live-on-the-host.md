---
status: accepted
---

# Host settings live on the Host, this computer included

Remote profiles (ADR-0062) made one desktop app show several machines at once, and the Agent list in the app's browser storage stopped fitting: an Agent installed on a server need not be installed on this computer, and the other way round. Because "switched on" was judged against this computer's installs, a server's panes did not recognise Agents that run fine there, and a remote Window's first-run step once rewrote this computer's list to the server's installs.

We decided that the settings which describe a machine, the **Host settings** (`GLOSSARY.md`), belong to its **Host** and are stored in that Host's own database: its Agent list (switches and custom Agents), Agent hooks and the Abundio skill, Agent control, Prompt actions, default shell and terminal scrollback. This computer is a Host like any other: its Host settings move out of the app's browser storage into its database, copied once. Appearance, fonts, the keymap, the "Working" output threshold and the app's other settings stay with this computer.

- A server's Agent list starts as the built-in Agents installed there, switched on by the server itself on its first start, with no app needed.
- Every pane reads its own Host's settings: the Agents it recognises and launches, the Prompt actions it shows (Cmd+1–9 included), the shell a new pane starts.
- Settings has a Host picker; the per-Host sections (Agents, Prompt actions, Profiles, the shell and scrollback part of Terminal) follow it. A Host that is not connected shows "Connect to edit", never a stale copy.
- Every app attached to a Host sees the same Host settings; the last change wins and the others update live.

## Considered Options

- **Keep one list on this computer, judged per Host when used** ("on here, or installed there"). Rejected: an Agent switched off on purpose would still run on a Host, and custom Agents would still be one list for machines that differ.
- **Keep a list per Host on this computer.** Rejected: a second computer would have its own copy of a server's settings, and the server could not read them while no app is attached (hooks provisioning, Agent control).
- **Leave this computer's Host settings in browser storage, servers in their database.** Rejected: two ways of reading the same settings.

## Consequences

- The Window no longer pushes these settings to the Hosts it joins (`TO_EVERY_BACKEND` keeps only the Working threshold); each Host already has its own.
- A first app start after the move copies this computer's current values into its database once; servers start from their installs on their next start.
