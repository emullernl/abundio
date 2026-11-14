# Orchestrator

One Agent per Profile that the user can ask about, and act through on, every other Agent of the Profile, in a third view of the Window. Plus `abundio file open`, so the Orchestrator (and every other pane) can show the user a file. See `GLOSSARY.md` (**Orchestrator**, **Orchestrator workspace**, **Orchestrator view**, **Orchestrator tab**, **Peek**), ADR-0057 and ADR-0058.

## Why

Agent control (ADR-0054, ADR-0055) already lets any Agent see and drive the whole Profile. What is missing is a place for that Agent, made for users with no coding or Agent experience: a home that needs no folder, a view that shows the system at a glance, and a way to put a file on screen.

## Decisions (from the design sessions)

| Topic | Decision |
|-------|----------|
| How many | One Orchestrator per Profile. |
| What it is | An ordinary Workspace row with `kind = 'orchestrator'`, so panes, Tabs, PTYs, Session resume and Agent control work unchanged. |
| Folder | `shared_root()/orchestrator/<profile-id>/Orchestrator/`, created and recreated by Abundio. Never picked by the user. |
| Where it shows | Only in the Orchestrator view. Left out of the Workspace list, Agents list, Fleet Console, Workspace cycle, Navigator, pickers and `abundio workspace list`. Still counts in the Overview bar and the Attention count. |
| Agent | The user picks one (Installed Agents, Claude Code first) on first open; changeable from the view's menu (stops the old one). |
| Handle | Reserved `Orchestrator`: refused for every other Agent, not renamable, skipped by Default handles. |
| Start | When the Orchestrator view is first shown in a session (opened or restored), through the PTY spawn (New task's script) in zsh/bash. A new pick starts plainly; otherwise it resumes, and a resume failing within 20 s falls back to a plain start in the script. If it exits: a "Start the Orchestrator" button. |
| Instructions | Abundio rewrites `AGENTS.md` (+ `CLAUDE.md` that points to it) on every start: role, plain language, use the abundio skill, ask before prompting/sending keys/starting/closing another Agent. Both include `my-instructions.md`, which is the user's and never touched. |
| Friendliness | Real Agent TUI, plus a welcome card and seeded Prompt actions ("What is everyone working on?", "Who needs me right now?", "Summarise today"). |
| View | Third view beside Workspace view and Fleet Console; exactly one on screen. Every view is restored on launch (reverses the Fleet Console's never-restored rule). |
| Entry | Overview bar button, `Cmd+Shift+O` / `Ctrl+Shift+O` (rebindable), Go ▸ Orchestrator, Command palette. A click on the Orchestrator's notification lands in the view. |
| Layout | Orchestrator tabs on top (a 50/50 split by default, stored as a ratio; draggable, collapsible, per Window); the Orchestrator workspace's own Tab bar and panes below, always visible. |
| Orchestrator tabs | Graph (first, never closed), at most one Peek, files of any Workspace of the Profile. Files are editable like a File pane. Remembered per Profile, except Peek. |
| Graph | React Flow (`@xyflow/react`) with a fixed org-chart layout of our own (no layout library). Orchestrator on top, one group box per Workspace, Agent nodes with status icon, handle, Progress line. Spawned panes under their spawner. Agents of not-Opened Workspaces greyed. |
| Animation | Agent control calls (caller → target edge, read dotted / act solid), spawning (node grows from spawner), status changes (pulse). `prefers-reduced-motion` respected. |
| Click | Single: Peek. Double: Switch to. Greyed node: a card with Relaunch workspace. |
| Menus | Agent node: the Agent menu + Peek + Ask the Orchestrator about it (sends at once; typed but not sent if the Orchestrator is Working). Workspace box: Open/Close Workspace, New agent, New task, Open file…. |
| `abundio file open` | Any pane, shells too. Path absolute or relative to the caller's current folder, inside the caller's or `--workspace`'s folder. `--tab` (default) / `--window`; `--focus`, `--line N`, `--diff`, `--preview`, `--commit <sha>`. Reuses an already open file. From the Orchestrator `--tab` is an Orchestrator tab (does not open the Workspace); elsewhere a new Tab in the file's Workspace (opens it in the background if needed). |
| Quickopen | `Cmd+P` in the Orchestrator view searches every Workspace of the Profile; a Workspace box's Open file… is limited to it. |

## Steps (ordered commits on `feat/orchestrator`)

Before running the app with step 1 in place, back up `abundio.db` (+ `-wal`, `-shm`): there are no down-migrations.

### 1. Storage (Rust)

- Migration `023_orchestrator.sql`:
  - `ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';`
  - `CREATE UNIQUE INDEX idx_one_orchestrator_per_profile ON workspaces(profile_id) WHERE kind = 'orchestrator';`
  - `ALTER TABLE profiles ADD COLUMN orchestrator_agent_id TEXT DEFAULT NULL;`
  - `orchestrator_tabs (id, profile_id FK cascade, position, kind 'file'|'diff'|'commit', workspace_id FK cascade, path, commit_oid, created_at)` and `profiles.orchestrator_selected_tab TEXT DEFAULT NULL`.
- `WorkspaceStore`: `Workspace.kind`; `ensure_orchestrator(profile_id, folder)` (idempotent, returns the row); `set_orchestrator_agent`, `orchestrator_agent`; tab CRUD.
- `orchestrator.rs` (new): `orchestrator_folder(profile_id)` under `app_paths::shared_root()`; `write_instructions(folder)` (rewrites `AGENTS.md`/`CLAUDE.md`, creates `my-instructions.md` only if missing).
- Commands: `orchestrator_ensure(profile_id) -> Workspace`, `orchestrator_set_agent`, `orchestrator_tabs_list/add/remove/reorder/select`.
- Tests: ensure is idempotent and one per Profile; deleting a Profile removes its Orchestrator and tabs; instructions rewrite keeps `my-instructions.md`.

### 2. Hiding it (Rust + frontend)

- `lib/types.ts`: `Workspace.kind`. `lib/workspaceKind.ts`: `isOrchestrator`, `workWorkspaces(list)`.
- Filter at every list site: `buildWorkspaceRows` (sidebar, Fleet tiles, Agents list, Workspace cycle), Navigator, Command palette, FileSearchPalette, Status bar, Overview bar's `totalWorkspaces`, WorkspacePicker, NewAgentDialog, AddAgentDialog, NewTaskDialog, WorkspaceSettingsDialog, `addWorktreeTargetId`.
- Workspace restore never puts it on the Opened list; the Orchestrator view opens it.
- Rust Agent control: `workspace_listing` and `pick_workspace` skip it; `--workspace` can not name it.
- Reserved handle: `agent_names::check` refuses `Orchestrator` (`handle_reserved`) for any pane outside an Orchestrator workspace; `lowest_free` never yields it; `checkNewHandle` / `setAgentHandle` mirror the refusal. Added to the shared handle grammar fixture.
- Tests for each pure filter.

### 3. The view switch

- `windowUiStore`: `orchestratorViewOpen` beside `fleetConsoleOpen` (at most one true; both false = Workspace view), both persisted. `toggleOrchestratorView`, `setOrchestratorViewOpen`, `showWorkspaceView` (what Switch to calls). Statistics stays an overlay over any view.
- App.tsx: render `<OrchestratorView>` beside `<FleetConsole>`; hide the sidebars in both; `workspaceViewOnly` gates also in the Orchestrator view.
- Keybinding action `toggle-orchestrator-view` (default `Cmd+Shift+O` / `Ctrl+Shift+O`), Command palette entry, Overview bar `ViewToggle`, Go ▸ Orchestrator menu item (`open-orchestrator` event via `emit_to_one_profile_window`, heard with `listenToThisWindow`).
- Update GLOSSARY (Fleet Console restore, Overview bar), CLAUDE.md shortcut table.

### 4. Orchestrator view shell + starting the Agent

- `components/Orchestrator/OrchestratorView.tsx`: top Orchestrator tab strip + area (a welcome card until the graph, step 6), divider. The bottom is **not** drawn by the view: while the view is on screen the Orchestrator workspace is the **Active workspace** and `App.tsx` draws it in the ordinary Workspace stack, placed under the top area (`orchestratorStore.panesTop`, z-index above the view). That reuses the Tab bar, lazy mounting, focus, WebGL budget, `isPaneVisible` and every pane shortcut (`paneLayoutOnly` lets splits, Tabs and save through; sidebar and Workspace shortcuts stay off).
- `lib/orchestratorSession.ts` (`installOrchestratorSession`, per Profile from `App.tsx`): enter = `orchestrator_ensure` → upsert into the store → picker if no Agent, else stamp the pane (Agent + handle) and seed/restart it → make it Active, remembering the Workspace to return to. Leave = make that one Active again. `setActiveWorkspace` never remembers it as the Profile's Active; Workspace restore treats it as "nothing picked" and hands its pick to the return slot.
- On first show in a session: `orchestrator_ensure` → `markWorkspaceOpened` → if no Agent pane and an Agent is chosen, `createTab(..., agent)` with handle `Orchestrator`; otherwise the Agent picker card. Welcome card while the Agent has no Turn yet.
- Exited Agent → "Start the Orchestrator" button.
- Notification / Attention flag click for an Orchestrator pane → `view = "orchestrator"`.

### 5. Seeded Prompt actions

- Prompt actions are app-global, scoped only by Agent id. Added `scope_kind = 'orchestrator'` (no CHECK to widen): offered only in panes of an Orchestrator workspace, first there. An older build of the same data epoch reads it as `all` and would show these three in every pane — accepted. Seeded once by `orchestrator_ensure` (`settings` key `orchestrator_actions_seeded`), so a deleted one stays deleted. Settings ▸ Prompt actions offers "Only the Orchestrator"; the bar's popover keeps that scope when editing, and defaults to it when creating in the Orchestrator's pane.

### 6. The graph

- `pnpm add @xyflow/react`. No layout library: `layoutGraph` places the boxes in rows that wrap to the graph area's shape (`aspect`), each row centred, the Orchestrator over them. Simpler than dagre and unit-tested.
- Pure `lib/orchestratorGraph.ts`: nodes/edges from workspaces, layouts, statuses, Progress lines, `spawnedBy`, Dormant workspaces' remembered Agents. Tested.
- `lib/controlActivity.ts`: a tiny pub/sub that `handleControlRequest` publishes to (caller pane, target pane, read/act) for animated edges; spawn and status-change events.
- `OrchestratorGraph.tsx`: React Flow, custom Agent and Workspace nodes, click / double-click / context menus.

### 7. Peek

- A Peek tab borrows the pane's terminal through `portalRegistry` at a priority over the Workspace-view slot (as Fleet tiles do, ADR-0040), and hands it back on close. Closes when its Agent exits.

### 8. File Orchestrator tabs

- An Orchestrator file tab renders the File pane views (CodeEditor / DiffViewer / ImageViewer / markdown preview) bound to the file's Workspace. Unsaved edits join `report_unsaved_files`. Reload on outside change via the file watcher (Orchestrator tab holds a watch).
- Profile-wide quickopen in the view; Workspace box Open file….

### 9. `abundio file open`

- The CLI wrapper sends the caller's `$PWD` (`X-Abundio-Cwd`) so relative paths resolve.
- Rust `Request::FileOpen { path, mode, focus, line, diff, preview, commit }`, parsing + help text + validation (reuse `file_windows::validate_target` logic; inside the scoped Workspace folder). Mutating. Not agents-only.
- TS case: from the Orchestrator pane → Orchestrator tab; else `--window` → `openFileWindow`, `--tab` → `explorerStore.openFile` / `openDiff` / `openCommitDiff` with `activate: focus`, then `setPendingGotoLine`. Reuse if open. The caller's node pulses.
- Skill: "Show the user a file" section; `--focus` only when the user asked.

### 10. Docs

- CLAUDE.md architecture map entries, GLOSSARY touch-ups, README feature line.
