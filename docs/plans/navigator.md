# Navigator

A dialog for going anywhere in the Window: Workspace › Tab › Pane, with
search and an Agent status filter. See **Navigator** in `GLOSSARY.md`.

## Decisions (from the design session, 2026-11-12)

- Opened with `Cmd+J` (macOS) / `Ctrl+Shift+J` (Windows/Linux), rebindable,
  and **Go ▸ Navigator…** in a new native Go menu on every platform.
- This Window only. Default scope: the Window's **Opened workspaces**. A
  toggle widens it to every Workspace in the **Active profile**; one that is
  not Opened shows no children.
- Tree: Workspace › Tab › Pane. Panes are agent panes, terminal panes, file
  panes (files, diffs, commit diffs) and preview panes. Merge side panes are
  left out (they belong to their file pane's Merge view). The Tab level is
  shown even for a single Tab.
- Order: Left sidebar order. Linked worktrees are indented under their
  Primary and always listed, even inside a Folded set.
- **File windows** (added after the first build): each open File window is
  listed under its Workspace, after its Tabs. Picking one makes its Workspace
  Active (which raises all its File windows without focus), then focuses the
  picked one. Hidden by the status filter. Rust lists them with
  `file_windows_list` (rows with a live window only) and focuses one with
  `file_window_focus`.
- Opens fully expanded, the current target pane (Focused pane, or Focused
  tile in the Fleet Console) preselected. Always opens fresh: Opened scope,
  no status filter, empty search.
- Search matches Workspace name and branch, Tab name, Agent name and terminal
  title, terminal folder, file name. A match shows with its ancestors; a
  matching Workspace or Tab also shows its contents.
- Status filter: chips Waiting / Working / Ready / Idle / Error, none = all.
  Any chip on: only Agents in those states; terminal and file panes hidden;
  Workspaces and Tabs left empty hidden.
- Rows reuse existing labels: Workspace name + branch + Status composite; Tab
  name + Status composite; Agent pane as an Agent row (status icon, Agent
  icon, terminal title); terminal pane status icon + title or folder; file
  pane file icon + name.
- Keys: type to search; Up/Down move; Left/Right collapse/expand (only with
  an empty search, so the caret still works while typing); Enter goes there;
  Esc closes.
- Picking: Workspace → Active (opened if not); Tab → that Workspace and Tab;
  Pane → **Switch to**. Always leaves the Fleet Console. Dialog closes.

## Implementation (one branch, ordered commits)

1. **Pure tree** — `src/lib/navigatorTree.ts`: build the visible rows (kind,
   depth, label, keys) from workspaces, sidebar rows, opened set, PTY store
   slices, scope, query, status filter and collapsed keys. Unit tests in
   `src/lib/__tests__/navigatorTree.test.ts`.
2. **Action + shortcut** — `open-navigator` in `keybindings.ts` (default
   chord, workspace-global, label "Navigator", category App).
3. **Dialog** — `src/components/Navigator/Navigator.tsx`: search box, scope
   toggle, status chips, tree list, keyboard handling, `useEscapeKey`.
   Mounted in `App.tsx`; opening closes the Command palette and quickopen.
   Command palette gets an "Open Navigator" entry.
4. **Menu** — Rust `build_menu` gets a Go submenu with item `navigator`;
   `on_menu_event` sends `open-navigator` with `emit_to_one_profile_window`;
   `App.tsx` hears it through `listenToThisWindow`. No accelerator on the
   menu item: a native accelerator would take the key before the webview and
   would have to follow rebinds the way Settings… does.
5. **Docs** — `CLAUDE.md` (component list, shortcut table), glossary entry
   (done).

## Not doing

- Other Windows' workspaces (would need cross-window state queries).
- Notes as tree entries.
- Remembering scope/filters between opens.
