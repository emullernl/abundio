# Agents list: Handle order, Agent menu, Agent cycle

Decided in a grilling session on 2026-11-14. Terms are in `GLOSSARY.md`
(**Handle order**, **Agent menu**, **Agent cycle**).

## Decisions

- The **Agents list** is sorted in **Handle order**: by **Agent handle**,
  ignoring case, one flat list across every Opened workspace. **Default
  handles** sort by their number ("Agent Two" before "Agent Ten"), placed where
  "Agent" falls alphabetically. Panes without a handle yet go last, in derived
  order.
- The **Fleet Console** keeps its derived (layout) order. Only the sidebar
  changes.
- Right-clicking an **Agent row** opens the **Agent menu**: Switch to, Open in
  Fleet Console, Rename Agent…, Copy handle, Clear Attention flag (only while
  set), Restart agent (resumes the session; always confirms), Close pane (the
  usual close confirmation). Items that do not apply are hidden.
- **Agent cycle**: `next-agent` / `prev-agent`, defaults Ctrl+Cmd+→/← (macOS)
  and Ctrl+Shift+End/Home (Windows/Linux), rebindable. Walks Handle order,
  wrapping. In the Workspace view it is a Switch to, starting from the Agent in
  the Focused pane (when it has none, next goes to the first Agent and
  previous to the last), and works with the list collapsed or hidden. Not
  workspace-global: in the code editor Monaco keeps Ctrl+Shift+Home/End. In the Fleet Console it moves the Focused tile
  in the Console's own order (the same as the Pane cycle there) and never
  leaves it.

## Commits

1. `lib/handleOrder.ts` (pure: Default handle number, compare, sort) + tests;
   Agents list sorted by it.
2. Agent menu on the Agent row: `restartAgentPane` in `lib/paneRestart.ts`,
   menu items built by a pure helper + tests.
3. Agent cycle: key actions, default chords, App action wiring, command
   palette entries, pure `cycleAgent` + tests.
