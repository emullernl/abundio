---
status: accepted (supersedes the asymmetric-propagation decision of ADR-0009)
---

# Tab and Workspace status splits into an Agent rollup and a Terminal rollup

ADR-0009 gave each Tab and Workspace one mixed status icon: every state of an agent-mode PTY, plus only the Error of a shell-mode PTY, so a long-running `npm run dev` would not colour it forever. Users could then see nothing of their terminals above the pane level. We replace that one icon with two: an **Agent rollup** (agent-mode PTYs only, Error > Waiting > Ready > Working > Idle) and a **Terminal rollup** (shell-mode PTYs only, Error > Working > Idle). A shell's Error now lives only in the Terminal rollup. The rest of ADR-0009 stands: shells have no Ready or Waiting, and shell Working is the cyan `>>>`.

- **Absent, not Idle.** A rollup with no PTYs of its kind draws no icon, so an icon always means "at least one exists" and a hover count is never zero. A Workspace never opened in the Window keeps the single grey "Not opened" icon.
- **A permanently cyan Terminal rollup is accepted.** A running dev server holds it at Working for hours. That is true, and it is on its own line in a calm colour, so it no longer drowns the Agent signal, which was ADR-0009's actual worry.
- **Layout.** Sidebar row and collapsed strip: the two stack in the left slot (Agent beside the name, Terminal beside the path). Tab: side by side before the name, Agent first, absent ones take no space. The Hidden rollup splits the same way at the row's right end. The collapsed strip's 7px badge shows only the more urgent of the two.
- **Hover** gives the full breakdown for that icon, most urgent first, zero counts omitted: "Agents: 2 Waiting · 1 Working · 3 Idle".

## Considered options

- **Keep the mixed icon and add a terminal icon beside it.** A shell error would show red twice. Rejected.
- **Leave Working out of the Terminal rollup (Error/Idle only).** Quiet, but it cannot say "something is running", which is the point of the rollup. Rejected.
- **Show shell Working only for its first N minutes.** Adds a hidden timer rule and cannot tell a long build from a server. Rejected.
- **Show an empty rollup as green Idle or dim grey.** Green claims Idle for Agents that don't exist; grey already means "Not opened". Rejected.

## Consequences

- An opened Workspace with no PTYs at all (only file panes) shows an empty left slot, where it used to show green.
- Only drawing changes. OS notifications (shell Error still notifies) and the Overview bar, which already counted Agents and Terminals separately, are unaffected.

**Update**: the Layout bullet above is superseded by ADR-0033, which draws the two rollups as one **Status composite** (a larger Primary icon with the Terminal rollup as a small corner badge) rather than two icons of equal weight. The model this ADR defines — two ladders, absent≠Idle, permanent cyan accepted, hover breakdowns — is unchanged.
