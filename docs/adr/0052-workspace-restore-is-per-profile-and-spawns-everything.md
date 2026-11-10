---
status: accepted
---

# Workspace restore is per Profile and spawns everything at once

Abundio used to forget which Workspaces were Opened: every Window started with nothing Opened and no Active workspace, and Switch Profile closed them all for good. Now each **Profile** remembers its Opened workspaces and its Active one (**Workspace restore**, see `GLOSSARY.md`). The list is saved in SQLite every time it changes, not at quit, so a crash, a force-quit or a reboot restores too.

Two parts of this are deliberate and may look surprising:

- **The list belongs to the Profile, not to the Window or the app start.** It comes back whenever the Profile is opened: at app start, by Switch Profile, or in a new Window. So Switch Profile and closing a Window no longer forget anything. Only closing a Workspace yourself takes it off the list. This gives one rule ("a Profile comes back as you left it"), the same rule File windows already follow with their Workspace (ADR-0046).
- **Every restored Workspace spawns its PTYs right away**, and Agent panes relaunch and resume their session (ADR-0050). Start-up is heavier, but "Opened" keeps meaning what it means everywhere else: its PTYs are alive, so status icons, the Fleet Console and the App icon badge are correct from the first second.

## Considered Options

- **Restore only at app start.** Rejected: Switch Profile and a new Window would still start empty, so there would be two rules to explain.
- **Spawn only the Active workspace and the rest on first visit.** Rejected: the others would appear Opened but have no live terminals, so an agent waiting for input in one of them would show no status until you clicked on it.
- **Save at quit.** Rejected: quit destroys Windows without running frontend code, and a crash would lose the list.

## Consequences

- Profile switch must close its Workspaces *without* forgetting them. `closeWorkspace` has a forgetting path (the user closed it) and a keeping path (Profile switch). Calling the wrong one silently empties the list.
- A Profile with many Agent panes starts many processes at launch. The setting "Reopen workspaces when a Profile opens" (on by default) is the way out. With it off, nothing is reopened in any case.
