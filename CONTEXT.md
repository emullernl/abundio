# Abundio

GPU-accelerated terminal multiplexer. The user opens one or more application Windows; each Window shows one Profile; each Profile owns a set of Workspaces; each Workspace runs its own pane layout and PTY processes.

## Language

**Window**: A single OS-level application window (Tauri `WebviewWindow`). Windows come in two kinds:
- **Profile-bound window**: owns exactly one **Profile** (one-to-one, exclusive — a Profile is open in at most one such Window at a time). Created via File → New Window with Profile. Appears in `windows.json` for restoration across launches and counts toward the "last-window-closing quits the app" rule. Labels follow the pattern `main` (the first window) or `window-<uuid>` (additional windows).
- **Auxiliary window**: serves a global purpose unrelated to any single Profile. Currently only the **Settings window**. Does not own a Profile, is not persisted in `windows.json`, and does not count toward the quit rule. Uses a stable singleton label (`settings`).

The label is the stable identifier across launches — both Abundio's own `windows.json` and `tauri-plugin-window-state` key per-window data by it.
_Avoid_: viewport, app instance, frame; do **not** use "window" to mean a **Pane** (see Pane).

**Settings window**: The singleton auxiliary **Window** labelled `settings`. Opens (or focuses if already open) via File menu, Cmd+,, or the "Manage Profiles…" deep-link. Edits the *global* profile registry — has no active Profile of its own. Theme, font, and agent changes here propagate live to all open Profile-bound windows via a Tauri event broadcast. See ADR-0008.
_Avoid_: preferences window, options dialog.

**Profile**: A top-level grouping of Workspaces — a named bundle the user uses to organize unrelated bodies of work (e.g. "Work", "Personal"). Each **Workspace** belongs to exactly one Profile and cannot be moved between Profiles after creation. The only per-Profile data today is the Workspace list; appearance, custom agents, env vars and GitHub identity remain global. Scope is intentionally narrow so the term may broaden later. A Profile is bound to at most one **Window** at any moment.
_Avoid_: space, group, namespace, context

**Active profile**: The single Profile currently shown in a given Window. Per-Window singleton — Window A's active profile is independent of Window B's, but a Profile cannot be active in two Windows at the same time. Switching Profile closes every Opened workspace in the previous Active profile of *that Window* (with a confirm dialog when any are open). Persisted across restarts per-Window.
_Avoid_: current profile, selected profile, focused profile

**Default profile**: The Profile created at migration time to host pre-existing Workspaces. After migration it has no permanent specialness: it can be renamed, and it can be deleted as long as another Profile exists. The system invariant is "at least one Profile must always exist" — not "the Default must exist".
_Avoid_: primary profile, root profile, main profile

**Workspace**: A folder-bound container with its own pane layout, tabs, and PTY processes. Belongs to exactly one **Profile**.
_Avoid_: project, folder

**Active workspace**: The single Workspace currently selected and visible to the user *within a Window*. Per-Window singleton (`useWorkspaceStore.activeWorkspaceId` — each Window has its own JS context and so its own store instance).
_Avoid_: selected workspace, current workspace, focused workspace

**Opened workspace**: A Workspace the user has activated at least once *in its Window* and has not closed. Tracked per-Window by `usePtyActivityStore.openedWorkspaceIds`. PTY processes and file watchers stay alive for these even when not the Active workspace.
_Avoid_: loaded workspace, mounted workspace

**Background workspace**: An Opened workspace that is not currently the Active workspace. Not a separate state — derived as `openedWorkspaceIds \ {activeWorkspaceId}`.

**Worktree set**: A group of Workspaces that are git worktrees of the same repository — one underlying repository, different branches checked out into different folders, each folder its own Workspace. Rendered as a single visually-distinct cluster in the **Left sidebar**; never a separate stored entity and never a **Profile**. Derived live from git, not persisted: two Workspaces belong to the same set iff their folders are worktrees of the same repository. A repository present only through its main worktree forms no set — the cluster chrome appears only once two or more worktrees of one repository exist as Workspaces. Within a set the **Primary worktree** is always rendered first, followed by the **Linked worktrees**.
_Avoid_: worktree group, repo group (collides with **Profile**'s sense of "group"), worktree cluster.

**Primary worktree**: The Workspace bound to a repository's *main* working tree (git's "main worktree"). Exactly one per **Worktree set**, always rendered first within it. **Add worktree** is offered here — and equally on a standalone git Workspace whose folder is a main worktree but has no set yet; that Workspace simply isn't *called* a Primary worktree until its first linked worktree exists.
_Avoid_: main worktree (git-side synonym, ok colloquially), root worktree.

**Linked worktree**: A non-primary Workspace in a **Worktree set** — a working tree git links to the repository's main one (git's own term for the non-main worktrees). The only Workspace on which **Remove worktree** is offered; removing it deletes that worktree's folder from disk.
_Avoid_: secondary worktree, child worktree.

**Workspace settings**: A per-Workspace dialog opened from the **Left sidebar** context menu (`Workspace settings…`). Hosts the Workspace rename and — only for **main-worktree** Workspaces (a **Primary worktree**, or a standalone main worktree) — the **Worktree setup commands** box; Linked worktrees and non-git Workspaces see the rename field alone. A plain in-window dialog, *not* the **Settings window** (which is a global, OS-level auxiliary Window editing the profile registry); Workspace settings edits one Workspace's own row.
_Avoid_: preferences, workspace config, settings panel (collides with **Settings window**).

**Worktree setup commands**: An ordered list of shell commands stored on a **main-worktree** Workspace's row and run in a newly created worktree's focal terminal immediately after an in-app **Add worktree** — and only then. A worktree created via the CLI and surfaced by live-sync is added unopened and runs nothing. The commands are sent as literal shell input (one line per command, the shell serializing them), ahead of any Agent chosen in the Add worktree dialog. Not a git "hook" and unrelated to **Agent hooks** or **Hook provisioning**.
_Avoid_: worktree hook, setup hook, post-create hook, init script.

**Pane**: A leaf slot within a Workspace tab. Panes form a recursive binary split tree (`PaneNode`). A Pane is one of: a **terminal pane** (holds a PTY), a **file pane** (holds an open file), or a **preview pane** (renders another pane's content).
_Avoid_: panel, window, split

**File pane**: A Pane that holds one open file — rendered as a Monaco editor (text), diff view, or image viewer depending on file type. Identified by its `filePath`.
_Avoid_: editor, viewer

**Preview pane**: A Pane that renders a live, read-only rendering of its **source pane**'s markdown buffer — including Mermaid diagrams. Owns no file of its own; it mirrors. Created beside a file pane when a markdown file is opened. Its appearance is governed by the **Preview color mode**.
_Avoid_: render pane, markdown viewer

**Preview color mode**: A global, persisted user preference governing every **Preview pane**'s appearance. Binary: **follow theme** (the default — the preview adopts the active theme's *actual colours*: its canvas, text, borders, links and accents match the rest of the UI) or **printed paper** (forced pure-white "document" look regardless of theme). There is no forced-*dark* state — a dark preview arises only because the active theme is dark. Toggled from the preview's title bar. Follow-theme remaps the document **surface** only; code-block **syntax-highlighting** token colours stay at the rendering library's light/dark defaults (themes carry no syntax palette). **Print** always renders on white paper, ignoring this preference. See ADR-0013.
_Avoid_: preview theme, dark mode

**Source pane**: The file pane a preview pane is bound to (`sourcePaneId`). The preview reflects this pane's unsaved buffer and follows it when a new markdown file is opened in it.

**Tab**: A named pane layout within a Workspace. Each tab has its own root `PaneNode`.
_Avoid_: view, screen

**Note**: A single per-Workspace rich-text scratchpad (free text + checklists), edited in the right sidebar's Notes tab and stored as TipTap JSON. Exactly one per Workspace; autosaved. See ADR-0012.
_Avoid_: memo, scratchpad, comment

**PTY**: A pseudo-terminal process bound to a Pane. Identified by a `ptyId` string. Spawned on first render; IDs from previous sessions are cleared on load.
_Avoid_: terminal process, shell

**Agent**: A detected AI coding CLI tool (Claude Code, Copilot, Gemini CLI, Aider, Codex, OpenCode) that can be launched inside a Pane. Detected by scanning `$PATH`; not spawned until the user requests one.

**Turn**: One unit of Agent work — from a prompt submitted (turn-start hook) to the turn finishing or failing (turn-finished / turn-failed hook). The atomic record for agent telemetry: one row per Turn in the `agent_turn` table, carrying its duration, **Working**/**Waiting** time, permission/tool/error counts, and the net lines it changed. See ADR-0018.
_Avoid_: run, request, interaction (and never "running" — collides with **Working**).

**Session**: The span of one Agent process in a Pane — from launch to `SessionEnd`/exit — comprising one or more **Turns**. Not a stored entity: it's a `session_id` stamped on each Turn so the **Statistics overlay** can group a session's Turns and answer "how long was the agent running". See ADR-0018.
_Avoid_: conversation, run.

**Statistics overlay**: A per-**Window**, full-area surface that covers the **workspace stack** (terminals stay alive behind it via the portal registry) to show agent **Turn** telemetry — working-vs-wall-clock time, net lines changed, per-agent and per-workspace breakdowns, an activity heatmap, and recent Turns — for the Window's **Active profile** over a selectable range (week/month/year/all). Launched from the one interactive control on the **Overview bar**; closed with its own button or Esc. Profile-scoped, so it refetches when the Active profile changes. See ADR-0018.
_Avoid_: dashboard, stats panel (collides with retired "panel"), stats view/screen (collides with **Tab**).

**Agent hook**: A lifecycle event an Agent emits — prompt submitted, permission requested, turn finished, turn failed — that Abundio observes (via the Agent's own hook system) to drive the status indicator. Abundio only observes; it never alters the Agent's behaviour. Distinct from **Hook provisioning** (the edits Abundio writes so these events reach it).
_Avoid_: callback, event listener

**Hook provisioning**: The set of edits Abundio writes into an Agent's *own* configuration so that Agent emits its **Agent hooks** to Abundio — distinct from the hooks themselves, which Abundio only observes. Comprises the relay scripts in Abundio's data dir plus, per Agent, either entries merged into a co-owned config (e.g. `~/.claude/settings.json`, `~/.gemini/settings.json`, `~/.qwen/settings.json`) or an Abundio-owned file (e.g. `~/.codex/hooks.json`, `~/.copilot/hooks/abundio.json`, `~/.config/opencode/plugin/abundio.ts`). Gated by the global **Status Hooks** setting; idempotent; removes only Abundio's own entries on disable. See ADR-0003.
_Avoid_: hook injection, hook registration (ok colloquially)

**Status Hooks setting**: The global, opt-out toggle (`agentHooksEnabled`) that turns **Hook provisioning** on or off. On by default. Provisioning of a given Agent is gated by **both** this global toggle and that Agent's own per-Agent toggle (the same one that enables its command detection): an Agent gets hooks only when both are on, and toggling an Agent off removes just its hooks (toggling it back on reinstalls them, if the global toggle is on). The **Provisioning footprint** display in Settings is read-only — the Agent's existing enable toggle is the per-Agent control.
_Avoid_: hooks preference

**Provisioning footprint**: The concrete, per-Agent record of what **Hook provisioning** has done — which config file is touched, whether Abundio owns that file or merged into a shared one, and which lifecycle events are hooked — surfaced read-only per Agent in Settings. Each Agent reads as one of: *Registered*, *Not registered*, *Not installed*, *Not supported* (Aider and custom Agents have no hook integration), or *Config error* (the Agent's config is unparseable).
_Avoid_: hook status (ambiguous with the **Status indicator**)

**Waiting**: An Agent state in which the Agent has emitted a permission- or input-request hook and the user has not yet responded in its terminal. Distinct from a finished turn ("ready") — the Agent is stalled mid-turn, not done.
_Avoid_: blocked, idle, stuck

**Working**: A PTY state in which work is in progress — an **Agent** mid-turn (between turn-start and turn-end hooks, not blocked on a permission/input request) or a **shell-mode PTY** between the shell-integration `command_start` and `command_end` markers. Distinct from **Waiting** (agent-only — blocked on the user) and from a finished turn/command. The status indicator differs by mode: agent-Working is the amber broken double-ring spinner (a warm "attention, watch progress" colour), shell-Working is the cyan breathing triple-chevron `>>>` (a cool "neutral throughput" colour — you started the command, no alarm needed).
_Avoid_: active (collides with **Active workspace**), busy, running

**Ready**: An **Agent** state in which the Agent finished its turn cleanly and the user has not yet acknowledged it (by focusing or typing in its pane). Shown as the purple status indicator. Distinct from **Idle** — Ready is a notification, Idle is the rested state after acknowledgement. **Shell-mode PTYs do not have a Ready state**: a clean command exit transitions straight to **Idle** — for a shell, the output that just rendered is itself the "you have something to look at" signal, and a separate notification state would be redundant. Only the **Error** state is surfaced for shells.
_Avoid_: finished, done, complete

**Idle**: A PTY's resting state — no work in progress, and the last finished turn or command (if any) has been acknowledged by the user. Also the default state for a freshly initialised PTY. Shown as the green status indicator.
_Avoid_: inactive, asleep

**Error**: A PTY state in which the most recent work failed — an **Agent** emitted an error hook (or its turn exited non-zero in agent mode), or a **shell-mode PTY**'s last command exited with a non-zero code that isn't a user-stop (130/143). Shown as the red status indicator. Cleared by user focus/click.
_Avoid_: failed, broken, crashed

**Status indicator**: The coloured dot Abundio shows for a Pane — and aggregated up to its Tab and Workspace — reflecting its PTY's current state. The state set differs by **PTY mode**: an **agent-mode PTY** can be Idle / Working / Waiting / Ready / Error; a **shell-mode PTY** can only be Idle / Working / Error (no Ready, no Waiting). Aggregation is also asymmetric: an agent-mode PTY propagates every state to its Tab and Workspace; a shell-mode PTY propagates only Error and otherwise contributes as Idle. So a tab whose only non-idle pane is a shell running a command reads green at the Tab level; a shell whose command errored turns its tab red. Working is shown in **different colours by mode** — amber spinner for an Agent (warm, attention-worthy), cyan breathing chevron `>>>` for a shell (cool, neutral throughput).

**Overview bar**: A horizontal strip across the top of the app window, between the **Titlebar** and the per-workspace tab row, showing glanceable global counts: **Opened workspaces** (out of total), each of the five **Agent** states (Idle, Working, Waiting, Ready, Error) aggregated across all opened workspaces, and the user's pending GitHub PR counts (review-requested and own open PRs, both account-wide). Always visible. Its counts are **read-only** in the sense that it never *mutates* app or workspace state; it carries exactly one **navigation affordance** — a right-aligned button that opens the **Statistics overlay**. The only piece of global chrome that lives between the Titlebar and the workspace stack. See ADR-0005, ADR-0018, ADR-0019.
_Avoid_: metrics bar, status bar (already taken — bottom of window), header. ("Dashboard" now names the **Statistics overlay** it launches — don't use it for the bar itself.)

**Status bar**: A horizontal strip across the bottom of a **Profile-bound Window**, beneath the workspace stack. Shows the **Active workspace**'s identity (name, current **Tab**, root folder) on the left, and on the right ambient telemetry — **machine-wide** CPU and memory load (not Abundio-specific; see Flagged ambiguities) — alongside the **Active profile**. Always visible; read-only. Counterpart to the **Overview bar**: the Overview bar (top) carries glanceable *global* agent/PR counts; the Status bar (bottom) carries *this Window's* workspace context plus system load.
_Avoid_: footer, info bar; do not call the **Overview bar** a "status bar".

**Sidebar**: A collapsible vertical strip of chrome flanking the workspace stack. Two instances, one on each side, with different responsibilities:
- **Left sidebar**: cross-workspace navigation — the **Workspace** list for the Window's **Active profile**. Belongs to the Window, not the Workspace.
- **Right sidebar**: in-workspace tooling for the **Active workspace** — three tabs (**Git changes**, **Explorer**, **Search**) plus an always-anchored **Pull Requests** section underneath the tabs. The tab strip and PR section are independent: the PR section is shared chrome across all three tabs and can be collapsed independently.

Both sidebars collapse to a 44px icon strip. Open/closed state and (for the right sidebar) the active tab + PR-collapsed state are per-Window. Width is global.
_Avoid_: panel (collides with **Pane** colloquially), drawer, rail.

**Update**: A newer published Abundio release the running app can fetch and apply via the Tauri updater. App-global, not per-Profile. Lifecycle: *available* → *downloading* → *staged* → *installed on quit*. By default applied only on the next natural quit so live **PTY**s and **Agent** turns survive; an explicit, confirmed "restart now" is the exception. The version check runs in Rust and surfaces in the focused **Window** only. See ADR-0014.
_Avoid_: upgrade, patch, version bump.

**Shell-mode PTY**: A PTY that Abundio has not currently detected as running an Agent — a plain shell. Its counterpart, an **agent-mode PTY**, has its status indicator driven by Agent hooks. A single PTY flips between the two as Agents are launched in it and exit.
_Avoid_: shell pane, terminal mode (a Pane has no mode — its PTY does)

**File drop**: Dropping one or more OS files (from Finder/Explorer) onto a **terminal pane** inserts their path(s) into that pane's PTY as bracketed-paste input — **never auto-executed**, with a trailing space; multiple files are space-separated. The target is the pane under the cursor, highlighted during the drag, and is focused on drop. The path format is **mode-aware**: a **shell-mode PTY** receives POSIX-single-quoted paths when they contain spaces/special characters (so the path survives as one shell token), while an **agent-mode PTY** receives the raw literal path (so the Agent resolves it). Always on; not gated by any setting. Delivered via Tauri's OS `drag-drop` events — distinct from the mouse-driven **Pane** drag used to reorder panes. The image special-case is **Smart image drop**.
_Avoid_: file paste; "drag and drop" unqualified (collides with pane reordering).

**Smart image drop**: The image special-case of **File drop**, governed by the global `smartImageDrop` setting (Terminal section, on by default). When **exactly one** image file (any raster format Abundio can decode — re-encoded to PNG) is dropped onto an **agent-mode PTY**, Abundio writes the PNG to the OS clipboard and sends the Agent a paste keystroke (`Ctrl+V` / byte `0x16`) so the Agent ingests it as if pasted, instead of inserting the path. It fires for *every* agent-mode pane regardless of whether that Agent can actually read a clipboard image, and does **not** restore the prior clipboard (see Flagged ambiguities). Multi-file drops, non-image files, **shell-mode PTYs**, and the setting being off all fall back to plain path insertion.
_Avoid_: image paste, paste-as-clipboard.

## Relationships

- Every **Workspace** belongs to exactly one **Profile**; the Workspace ↔ Profile assignment is set at creation and not editable afterwards.
- Each **Profile-bound Window** shows exactly one **Profile**, and each Profile is shown in at most one Window. Opening a new Window requires picking a Profile that is not already shown elsewhere (or creating a new "Untitled" Profile inline from the File menu).
- **Auxiliary windows** (e.g. the **Settings window**) do not own a Profile, are not persisted in `windows.json`, and do not count toward the "last window closing quits the app" rule. Closing every Profile-bound window quits the app even when the Settings window is still open.
- The sidebar of a Window shows only Workspaces in *that Window's* **Active profile**.
- The set of **Opened workspaces** is always a subset of the Window's **Active profile**'s Workspaces — switching Profile *within a Window* closes every Opened workspace in that Window's previous Active profile.
- At least one **Profile** must always exist. Deleting the **Active profile** auto-switches the Window to the first remaining Profile in position order that is not already open in another Window. A Profile cannot be deleted while it is open in another Window; the active Profile cannot be deleted if no unowned profile is available to auto-switch into. Deleting any Profile cascade-deletes its Workspaces.
- The **Active workspace** is always also an **Opened workspace**.
- A Workspace shown in the sidebar may be neither Active nor Opened — it has not been activated this session.
- **Closing** a Workspace removes it from Opened; deleting also removes it from the sidebar.
- A **Worktree set** is derived, not stored: two Workspaces belong to the same set iff their folders are worktrees of the same git repository. Membership and primary-vs-linked status are recomputed from git, never authored by the user. **Add worktree** is offered on any Workspace bound to a repository's *main* worktree — a **Primary worktree** when a set already exists, or a standalone git Workspace not yet in a set (its first add bootstraps the set). **Remove worktree** is a **Linked worktree**-only action that physically deletes that worktree's folder.
- **Worktree setup commands** are configured per main-worktree Workspace (stored on its row, so a repo present in two Profiles keeps an independent copy) and execute only on an in-app **Add worktree**, in the new worktree's focal terminal, before any chosen Agent. They are edited in the **Workspace settings** dialog.
- Each **Tab** belongs to exactly one **Workspace**.
- Each **Workspace** has at most one **Note** (one-to-zero-or-one); the Note is deleted with its Workspace.
- Each **Turn** belongs to exactly one **Profile** (stored directly on the row) and references at most one **Workspace** (denormalized by id + name). Lifetime is deliberately asymmetric: deleting a **Profile** cascade-deletes its Turns; deleting a **Workspace** does **not** (so historical totals don't shrink). Turns are grouped into **Sessions** by `session_id`. See ADR-0018.
- Each **Pane** belongs to exactly one **Tab**. A terminal pane holds at most one **PTY**; a file pane holds at most one open file; a preview pane holds neither — it references a **source pane**.
- A **preview pane** and its **source pane** always live in the same **Tab**.
- Abundio derives an **Agent**'s status by observing its **Agent hooks**; a permission-request hook puts the Agent into the **Waiting** state, which clears when the user types into that **Pane**'s terminal.
- **Hook provisioning** runs at several moments, gated by the **Status Hooks setting** and each Agent's own enable toggle: at app startup (once per process, however many **Windows** open), on toggling the global setting, on toggling an individual Agent (its hooks are installed or removed to match), and the first time an Agent is launched in a **Pane** if not yet provisioned. The launch-time path may create the Agent's config dir if absent — a launch is explicit intent — whereas startup/toggle never scaffold dirs for Agents the user hasn't run. A newly-installed or newly-enabled Agent therefore gains hooks without an app restart. See ADR-0003.
- Installing an **Update** is deferred to app quit by default: the staged install runs in the quit path (the `quit-app` menu item / `ExitRequested`) before Windows tear down, so it composes with the "last-window-closing quits the app" rule rather than interrupting a running session.
- Abundio derives a **shell-mode PTY**'s status from shell-integration OSC markers (`command_start` / `command_end`) emitted by Abundio's startup hooks; **Working** and **Error** for shells are detected this way (a clean exit returns to **Idle**, with no Ready hop). Without working shell integration the PTY degrades silently to permanent **Idle** (no false signal).

## Flagged ambiguities

- "Window" has two meanings in Abundio code and conversation, and they are unrelated: the **Window** entity (OS-level application window — a Tauri `WebviewWindow`) is canonical; the historical use of "window" to mean a **Pane** is forbidden. When discussing Panes, use "pane" or "split"; when discussing Windows, capitalise to disambiguate where ambiguity would arise.
- "Profile" in Abundio refers exclusively to the top-level grouping entity. Despite borrowing the word from VS Code / browser conventions (where it bundles identity + settings), Abundio's Profile currently only groups Workspaces — appearance, agents and GitHub identity remain global. The term was kept against the narrower fit of "Space" or "Group" so that the scope may widen later without renaming.
- "active workspaces" (plural) does not exist — **Active workspace** is a singleton. Colloquial use of the plural is resolved to **Opened workspaces** (the set of workspaces activated this session and still open). The **Overview bar** uses "Opened" as its label for this reason.
- "background loaded workspace" was used to mean both "every sidebar workspace" and "opened-but-not-active workspace" — resolved to the latter (an Opened workspace that is not Active).
- "dormant workspace" is **not** a distinct state — it denotes a sidebar Workspace that is **neither Active nor Opened** (one not activated this session, per the relationship "A Workspace shown in the sidebar may be neither Active nor Opened"). Use that phrasing; "dormant" carries no extra meaning.
- "panel" is used colloquially to mean both a **Pane** and a **Sidebar** — resolved by retiring "panel" from canonical use. Side chrome is always a **Left sidebar** or **Right sidebar**; the historical names "git panel" / "git changes panel" no longer fit because the right sidebar hosts Git changes, Explorer, Search, and PRs together. When referring to a section *within* the right sidebar, use its tab name ("Git changes tab", "Explorer tab", "Search tab") or "PR section".
- "shell mode" / "terminal mode" were both used for a PTY not running an Agent — resolved to **shell-mode PTY**; the mode belongs to the PTY, not the Pane.
- The amber state is canonically **Working** in this doc — applying to both agent-mode and shell-mode PTYs — but `PtyActivityState` in code still uses the string `"active"`. Renaming the code value to `"working"` would remove the collision with **Active workspace** and align with the broadened glossary; deferred as a follow-up.
- The **Status bar**'s CPU/memory readout is **machine-wide**, not Abundio's own footprint, despite the original request being "usage of the application". Per-app attribution was investigated and rejected: Abundio's heavy memory lives in WebKit content processes that macOS reparents to `launchd` and only re-groups via private APIs that proved missing or contaminated on the target machine. Resolved to system-wide load (see ADR-0011).
- "no workspace selected/opened" was used loosely for the **Pull Requests** section's empty state — resolved to "the set of **Opened workspaces** is empty" (zero workspaces activated this session), *not* merely "no **Active workspace**". In that state both PR sub-sections force their account-wide (`-all`) view regardless of each section's stored repo/all preference (the preference is preserved and restored when a workspace reopens). As of ADR-0019 the *mechanism* is no longer a per-workspace fetch: an app-global poller always runs **one** account-wide `gh api graphql` query (from the home directory), and `-all` vs `-repo` is a **client-side filter** over that single dataset — so the empty-Opened-set state forces `-all` simply because there is no active repo to filter to, not because repo-scoped data can't be fetched without a cwd. This still reverses ADR-0005's original concession of "no PR data until a Workspace opens" — see ADR-0005, ADR-0019.
- Copilot's **Waiting** is driven by the `notification` hook, not `permissionRequest`. `permissionRequest` fires for every permission-gated tool even when auto-approved (order `preToolUse → permissionRequest → postToolUse`), so it can't tell a genuine block from autopilot at request time. Copilot's `notification` hook instead carries a `notification_type`, and a real permission prompt arrives as `notification_type: "permission_prompt"` (only on genuine prompts — empirically clean despite github/copilot-cli#2586). Abundio provisions the `notification` hook with a `matcher: "permission_prompt"` so only real prompts reach it, then maps `notification → Waiting` directly. The two prompt-tools that emit no `notification` (`exit_plan_mode`, `ask_user`) keep an immediate-Waiting via a `preToolUse` hook matcher-scoped to just those two tool names. The Waiting dot is held against the prompt's own render output by a `recordOutput` guard (agent-mode Waiting is cleared only by a keystroke or the next hook — the invariant **Idle**/`markIdle` already documents) and cleared on the user's keystroke (digit/Enter → Working, ESC → Idle) or `agentStop`. Other Agents enter **Waiting** immediately on a permission/input hook — theirs fires only on a genuine prompt. See ADR-0015.
- **Smart image drop** fires the clipboard trick for *every* **agent-mode PTY**, not only Agents that can read a clipboard image. Empirically only Claude Code (macOS) and Gemini CLI ingest a clipboard image on `Ctrl+V`; Codex, Copilot, OpenCode and Aider do not. Dropping an image on one of those Agents therefore overwrites the user's clipboard and silently attaches nothing — no path is inserted as a fallback. This was chosen deliberately, trading per-Agent correctness for a single simple gate (agent-mode vs shell-mode); revisit if per-Agent capability gating becomes worthwhile. The clipboard is intentionally **not** restored afterwards because the Agent reads it asynchronously after the keystroke, so any restore would race the read.
- The **Statistics overlay** is **Profile-scoped** (it counts only the Window's **Active profile**'s **Turns**) even though it is launched from the **Overview bar**, which is otherwise *global* chrome (its counts aggregate across all opened workspaces, and its PR counts are account-wide). The button is global; the surface it opens is per-Profile. Resolved deliberately — the overlay behaves like in-Profile tooling, not account-wide chrome. See ADR-0018.
- A **Turn**'s line counts are a **net-vs-base-branch git delta** (additions/deletions vs the base branch, snapshotted at turn start and end), *not* a precise tally of the lines the Agent itself wrote. They are approximate: a commit, manual edit, or revert during the Turn shifts them. (A brand-new file the Agent creates is counted from the moment it exists — even before `git add` — by counting its lines as additions, the same way `git diff --numstat` treats a new file.) They are also recorded as **NULL ("unmeasured")** when two Turns overlap in the same **Workspace**, because the per-Workspace delta can't be split between them. The UI labels this ("net vs base", "unmeasured"). See ADR-0018.
- **File drop** on Windows is shell-aware for **Git Bash** but not yet for cmd.exe/PowerShell. A drop onto a Git-Bash (MSYS) pane converts Windows paths to their `/c/…` unix form (so the path resolves, and POSIX single-quoting is then correct). cmd.exe and PowerShell panes keep their native `C:\…` style (correct), but still receive POSIX quoting, which is **wrong** for them (cmd single quotes aren't metacharacters; PowerShell rejects the `'\''` escape) — tracked as `TODO(windows)` in `lib/fileDrop.ts`, to be fixed with per-shell quoting. The pane's shell kind is derived from the user's `shellPath` setting, falling back to the Rust-resolved System Default (`default_shell` command); a pane spawned before the user last changed that setting could be misclassified (rare, since the setting is global and seldom changed mid-session).
