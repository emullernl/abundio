---
status: accepted
---

# Agent control reaches a joined Host's Agents, one way, through the app

Agent control (ADR-0054) reached only the backend a caller's pane runs on, so with **Joined profiles** (ADR-0062) the local Orchestrator and local Agents could not drive the Agents a Window shows from a Host. We decided that an Agent on this computer reaches the Agents of its own Profile's Joined profiles, with every operation, and that a Host's Agents never reach this computer. The desktop app carries such a call to the Host over its own connection there; the Host has no way to call back.

- A remote Agent or Workspace is named with the Host's name after an `@` (`Agent Two@build-box`, `--workspace app@build-box`), as the Host chip shows it; a bare name means this computer's. Handles stay unique only within one backend (ADR-0055).
- `workspace list` (the Profile-wide listing an Orchestrator starts from; `agent list` covers one Workspace) includes the joined Hosts' Workspaces and their Agents, named `<name>@<host>`, and shows those of a Host that is not connected as offline; a call to one fails at once with `host_offline`, never waiting for a reconnect.
- A Host's own Agent control switch (a Host setting, ADR-0064) governs its panes whoever calls: off there, nothing reaches them.
- The Host shows the caller as `Agent One@<this computer's name>` (the OS's computer name) on the pane's Control badge, in every app attached to it, and records it as the owner of a pane it starts there (a Spawned pane), until the local pane closes or the Joined profile is left.
- A joined Workspace that is not Opened is opened in the caller's Window in the background, as a local one is.

## Considered Options

- **Both ways** (a Host's Agents may reach this computer's too). Rejected: a Host is often a shared or less trusted machine; one whose Agents could type into this computer's panes would make every Host as trusted as this computer. The Host also cannot reach this computer except through the app's connection, and opening that path would need a new way in.
- **The Host reaches this computer's Agents only when asked** (a per-Host switch). Rejected for now: the same risk on a switch, for no use the user has.
- **A local Agent calls the Host's control endpoint itself** (its own SSH, or a token of the Host's). Rejected: the Agent would need credentials for the Host, and every pane on this computer would carry them. Going through the app reuses the connection the user already trusts, which may already type into any of the Host's panes, so the Host grants nothing new.
- **Only reading and prompting remote Agents.** Rejected: an Orchestrator that cannot start or close helpers on a Host cannot run work there.

## Consequences

- A wait can never cycle across machines: a Host's Agents cannot wait on this computer's, so each backend's own cycle check stays enough.
- The Host accepts Agent control calls from a Client on behalf of a caller that is not its own pane, limited to the Profile that Client shows (`client_profile_set`); its per-pane token rule (ADR-0054) still governs every call from its own panes.
