---
status: accepted
---

# A Missing folder starts nothing, and is Active without being Opened

A Workspace's folder can be missing: an external drive or share is not mounted yet, or the folder was deleted or renamed outside Abundio. Before this, opening such a Workspace still started its terminals. `pty_manager` quietly fell back to the user's home folder whenever the start folder was not a directory, so an Agent pane relaunched an agent in `~`, ready to read and change the wrong files, and nothing said so. **Workspace restore** (ADR-0052) made this more likely, because it keeps Workspaces with missing folders on the restore list.

We decided:

- **Nothing new starts in a Missing folder.** `pty_spawn` looks up the Workspace's folder itself. If that folder is missing, the spawn is refused and the pane prints `Folder not found: <path>`. This covers every path: new tab, split, pane restart, agent relaunch and New task. If only the pane's own remembered folder is missing (say, a deleted `build/`) and the Workspace folder exists, the shell starts in the Workspace folder. The home folder is never a fallback for a Workspace pane. Terminals that are already running are left alone: killing them on a brief unmount (sleep, a network blip) would lose an agent's work.
- **Selecting a Missing-folder Workspace makes it Active but not Opened.** The main area shows a "Folder not found" panel, with **Try again** and **Remove workspace**, in place of its panes. Until now, Active always implied Opened (`setActiveWorkspace` marked it). A Workspace in the panel is not Opened: it has no PTYs, it is not added to the restore list, and status icons, the Fleet Console and the badge do not count it.

## Considered Options

- **Open anyway, with a warning banner.** Rejected: a warning does not stop an agent that is already running in the wrong folder.
- **Make the row unselectable.** Rejected: there would be nowhere to explain the problem or offer Remove.
- **Kill an Opened Workspace's terminals when its folder disappears.** Rejected: a short unmount would end agents mid-task.
- **Check only in the frontend.** Rejected: there are several spawn paths, and Rust already receives the Workspace id with every spawn. One check in `pty_spawn` cannot be bypassed by a path someone adds later.

## Consequences

- Code that reads `activeWorkspaceId` must not assume that Workspace is in `openedWorkspaceIds`.
- Folders are checked when the Workspace list loads and when the Window gets focus, not in the background. A drive mounted while the app has focus is noticed when you click **Try again**, or the next time the Window gets focus.
