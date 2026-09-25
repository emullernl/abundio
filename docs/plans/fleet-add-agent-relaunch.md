# Fleet Console: Add agent + Relaunch dormant workspaces

Branch: `feat/fleet-relaunch-dormant` (off `feat/fleet-console`).
Terms: **Dormant workspace**, **Add agent**, **Relaunch** in `CONTEXT.md`.

## Problem

The Fleet Console only shows Agents in Opened workspaces. A user whose other
Workspaces remember Agents sees one "New agent" tile and empty outlines, and
has no hint that opening those Workspaces would bring their Agents back.

## Decisions (from the grilling session)

1. **Dormant workspace** = in the Active profile, not Opened in this Window,
   and its saved layout remembers at least one Agent that Abundio still knows
   (an unknown `agentId` would come up as a plain shell, so it does not count).
2. Every free grid cell, the Filmstrip's end cell and the toolbar carry the
   same **Add agent** button. The dashed empty outlines go.
3. Add agent opens a chooser with two clearly separate options: **New agent**
   (the existing dialog) and **Relaunch from a dormant workspace**. With no
   Dormant workspace it skips the chooser and opens New agent directly.
4. The toolbar shows a clickable `N dormant` count, which opens the chooser
   already on the Relaunch list.
5. Relaunch opens the whole Workspace in the background (`openInBackground`),
   so every remembered Agent relaunches. It is labelled "Relaunch", not
   "resume": each Agent starts a fresh session.
6. The Relaunch list groups Worktree sets like the workspace picker
   (`buildWorkspaceRows`): Linked worktrees indented under the Primary, branch
   on every row, only Dormant members listed, an Opened Primary shown as a
   plain heading. The list stays open after a click and closes by itself when
   nothing Dormant is left.

## Commits

1. **`lib/dormantWorkspaces.ts`** (pure) + tests:
   `rememberedAgents(ws)`, `isDormant(ws, opened, knownAgentIds)`,
   `dormantWorkspaces(...)`, `agentCounts(agentIds)`,
   `buildRelaunchRows(workspaces, facts, opened, knownAgentIds)`.
   `WorkspacePicker.rememberedAgentPanes` delegates to it.
2. **`AddAgentDialog`**: chooser step + Relaunch step in one modal shell;
   hands off to `NewAgentDialog` (which gains `onBack` and `animateIn`, so the
   swap does not flash the backdrop). `useEscapeKey` for Esc; ↑↓/Enter in both
   steps.
3. **Console wiring**: free cells and the Filmstrip end cell become
   `AddAgentCell` (with an "or relaunch N dormant" line when there are any);
   toolbar button renamed to Add agent; the dormant count button. `gridShape`
   doc comments updated.
4. **Docs**: README keybinding/feature text if it names "New agent".

## Tests

- Pure helpers: dormant predicate (opened, no agents, unknown agent), agent
  counting order, relaunch rows for standalone, set with dormant primary, set
  with Opened primary (heading), set with nothing dormant (skipped).
- Existing `WorkspacePicker` and `fleetConsole` tests stay green.
- Runtime: `pnpm demo:web`, open the Console, check the chooser, Relaunch a
  Workspace and watch its tiles appear.
