---
status: accepted
---

# `abundio file open` lands where its caller lives

The **Orchestrator** (ADR-0057) must be able to show the user a file of any Workspace in its Profile, and every other Agent benefits from the same: "look at this file, line 42". We added `abundio file open <path>` to **Agent control**, open to every pane, shells included: it shows a file and speaks in no Agent's name, so ADR-0056's agents-only rule does not apply.

- **The path** is absolute or relative to the caller's current folder, and must resolve inside the caller's Workspace folder or the folder of the Workspace named with `--workspace` (any Workspace of the Profile, per ADR-0055). Rust checks this, as it does for File windows. A **Missing folder** is refused.
- **Where it lands depends on the caller.** `--window` is always a **File window**. `--tab` (the default) is, from the Orchestrator, an **Orchestrator tab**; from any other pane, a new **Tab** in the file's Workspace holding one **File pane**, made through `createTab`'s `spawn` option so the caller's own layout never changes. A file already open in that place is reused, not duplicated.
- **Focus moves only with `--focus`**, as everywhere in Agent control: a File window is raised without focus, a new Tab or Orchestrator tab is not selected.
- **Options**: `--line N`, `--diff` (live working-tree diff), `--preview` (markdown rendered), `--commit <sha>` (the file as that commit changed it; excludes `--diff` and `--preview`).
- **An Orchestrator tab does not open its file's Workspace.** A Tab or File window lives only while its Workspace is Opened, so those open it in the background, starting its remembered Agents, as Agent control already does. An Orchestrator tab only reads and writes one file, so it needs no running Workspace, and the Orchestrator can show a file without waking a whole Workspace.

**Orchestrator tabs are not Tabs.** A Tab is one Workspace's pane layout; Orchestrator tabs show files of many Workspaces side by side, each as a File pane of its own Workspace would (editable, reloaded on outside change, part of the quit dialog's unsaved edits). They are remembered per Profile, except the **Peek**.

## Considered Options

- **Ordinary Tabs of the Orchestrator workspace** for its files. Rejected: files of other Workspaces would belong to the Orchestrator workspace, breaking "a file belongs to its Workspace" that File windows and the folder checks rely on.
- **Always a Workspace Tab**, even for the Orchestrator. Rejected: the user would see the file only after leaving the Orchestrator view.
- **Split beside the caller** for `--tab`. Rejected: it rearranges a layout the user built.
- **Any file on disk.** Rejected: no Workspace owns it, and an Agent could put `~/.ssh` on screen.

## Consequences

- The CLI sends its working folder in front of every call's arguments, marked (`\u{1}cwd:`), and Rust takes it off; a header could not carry a folder name that is not ASCII.
- Rust decides inside-or-outside before existence, so a refusal never tells an Agent whether a file outside the Workspace exists.
- A File window opened this way always comes forward with focus (the window-open command focuses), and `--preview` does not choose a File window's view; both are left as they are for now.

