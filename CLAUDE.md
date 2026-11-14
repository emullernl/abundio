# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Abundio is a GPU-accelerated terminal multiplexer desktop app built with Tauri v2. It manages workspaces (each bound to a folder), supports split panes with tabs, and has first-class support for AI coding CLI agents (Claude Code, GitHub Copilot CLI, Gemini CLI, Codex, OpenCode, Qwen Code, Kimi Code, Grok Build, Mistral Vibe). It includes a built-in file explorer, code editor (Monaco), git integration, GitHub PR panel, and full-text workspace search.

> **Domain language**: see `GLOSSARY.md` for canonical term definitions (Workspace, Pane, PTY, Tab, Agent, etc.) and flagged ambiguities to avoid.

## Tech Stack

- **Framework**: Tauri v2 (with plugins: shell, notification, dialog, window-state, os)
- **Backend**: Rust (edition 2021) — `portable-pty`, `rusqlite`, `crossbeam-channel`, `dashmap`, `notify`, `font-kit`, `ignore`, `regex`
- **Frontend**: React 19 + TypeScript 6 + Vite 8
- **Terminal**: `@xterm/xterm` 6.x with WebGL addon (canvas fallback)
- **Code Editor**: Monaco Editor (`@monaco-editor/react`)
- **State**: Zustand 5
- **Styling**: Tailwind CSS v4 (CSS variables for theming)
- **Animations**: Framer Motion
- **Icons**: Lucide React
- **Linting**: Biome (tab indentation)
- **Package manager**: pnpm

## Architecture

### Rust Backend (`src-tauri/src/`)

- `pty_manager.rs` — Per-PTY dedicated OS threads with crossbeam channels. PTY types never cross async boundaries. Output is base64-encoded and emitted via Tauri events.
- `app_paths.rs` — Every on-disk path, split into **shared** (`<data>/abundio/`: hook relay scripts, shims) and **epoch-versioned** (`<data>/abundio/v2/`: database, pty-logs, shell-integration, windows.json). Also does the one-time import of the previous epoch's database. See ADR-0025.
- `workspace_store.rs` — SQLite CRUD for workspaces, layouts, tabs. DB at `~/Library/Application Support/abundio/v2/abundio.db`.
- `env_crypto.rs` — Master key in the OS credential store (`keyring`) + AES-256-GCM seal/open for environment variable values. No DB, no Tauri, so it tests with an injected key.
- `env_vars.rs` — `EnvVarStore`: per-Workspace **Environment Bundles** and their variables, plus the `env_*` IPC commands. Owns its own DB connection so PTY spawn never queues behind the WorkspaceStore mutex. See ADR-0024.
- `agent_registry.rs` — Detects installed agents by scanning `$PATH` directories (no subprocess spawning).
- `agent_control.rs` — **Agent control** (ADR-0054): per-PTY tokens (`ABUNDIO_AGENT_TOKEN`), parsing the `abundio` CLI's argv, the wait graph that refuses cycles, and routing each call to the Window that owns the caller's Workspace (`agent-control-request` → `agent_control_reply`). Served on the hook server's `POST /control`, one thread per request. The `abundio` / `abundio.ps1` client scripts are written by `pty_manager::write_abundio_cli`.
- `agent_names.rs` — **Agent handles** across a Profile (ADR-0055): `number_words`, **Default handles** ("Agent Two"), the Profile-wide uniqueness check read from every layout in the database, and short in-memory reservations so two Windows never hand out the same default.
- `agent_skills.rs` — **Skill provisioning**: the Abundio skill (`src-tauri/skill/SKILL.md`) at `~/.agents/skills/abundio/` plus a link (or copy) for Claude Code; marker file `.abundio-managed`, never touches a folder without it.
- `commands.rs` — All `#[tauri::command]` handlers. All return `Result<T, AbundioError>`.
- `error.rs` — `AbundioError` enum (variants: `Pty`, `Db`, `Io`, `NotFound`, `Channel`) using thiserror + Serialize.
- `events.rs` — Event structs for PTY output (`PtyOutput` with base64 data) and status (`PtyStatus`: Running/Exited).
- `config.rs` — `AppConfig` struct (fontFamily, fontSize, theme). Defaults: "JetBrains Mono", 14pt, "default".
- `shell_env.rs` — `default_shell()`: reads `$SHELL` env var, falls back to `/bin/zsh`.
- `migrations.rs` — Auto-runs SQL migrations on startup, tracks applied in `_migrations` table.
- `file_explorer.rs` — File system operations: list directory, read/write files, check existence.
- `file_watcher.rs` — File system watcher (notify crate) initialized on app setup.
- `file_windows.rs` — **File windows** (ADR-0046, ADR-0049): the `file_windows` table (one row per remembered window, keyed by file, kind and commit; stable `md-<uuid>` label, last view), per-kind path validation, in-memory dirty flags, and the `file_window_*` / `file_windows_*` commands. Kinds: `text` (markdown also rendered), `image`, `diff` (live) and `commit-diff`. Text and image paths are absolute and must be an existing file of that kind inside the Workspace folder; diff paths are Workspace-relative.
- `window_placement.rs` — **Window placement** (ADR-0051), pure: `capture` / `resolve` keep a window's spot relative to its monitor in logical points; `Remembered { home, away }` keeps a window's monitor while that monitor is unplugged; `from_legacy` guesses from the old window-state file for a window with no placement of its own (the plugin keeps those entries frozen, never updated).
- `window_frame.rs` — Platform glue for Window placement: monitors and frames without tao's mixed-scale physical positions, `PlacementTracker`, `place_and_show` (windows are built hidden and placed first), `record_all` before every save.
- `desktop.rs` — The desktop part of a Window placement: macOS restorable state replayed with the private `_windowRestorationOptions` (Chromium's method), Windows `IVirtualDesktopManager`, X11 `_NET_WM_DESKTOP`. App start only.
- `window_raise.rs` — `raise_without_focus`: per-platform native calls (AppKit `orderFront`, Win32 `SetWindowPos` + `SWP_NOACTIVATE`, GDK `raise`) behind the **File window raise**. Skips minimised windows and windows on another desktop.
- `unsaved_edits.rs` — Cross-window list of unsaved File panes and File windows, the quit dialog's message, and Save and Quit.
- `app_badge.rs` — **App icon badge**: sums each Profile window's reported **Attention count** and draws it (Dock / Linux launcher via `set_badge_count`; Windows via a drawn taskbar overlay on every window).
- `owner_map.rs` — `OwnerMap`: which Windows hold each git scheduler worker and file watch. A Window's `Destroyed` releases its holds, because React cleanup never runs when a webview is destroyed.
- `search.rs` — Full-text workspace search with cancellation support (`fs_search`, `fs_search_cancel`).
- `git_commands.rs` — Git operations: changed files, file diffs, branch info, list branches, status fingerprint.
- `gh_commands.rs` — GitHub CLI integration: PR status, review requests, user's PRs.
- `dev_environments.rs` — Desktop IDE detection and launch (VS Code, Cursor, JetBrains, etc.). Pure Rust, no app state.
- `process_monitor.rs` — Process monitoring for PTY child processes.
- `lib.rs` — App entry with `Builder::setup()` that initializes DB, PTY manager, agent registry, and file watcher via `app.manage()`.

### Frontend (`src/`)

#### Components

- `components/Terminal/` — Terminal pane system: `TerminalInstance`, `TerminalSlot`, `TerminalPool`, `SplitContainer`, `TerminalTitleBar`, `PaneResizer`, `SearchBar`, `PaneContextMenu`, `DebugActivityMeter`.
- `components/Sidebar/` — `Sidebar`, `WorkspaceList`, `WorkspaceItem`, `AgentsList` + `AgentRow` (the **Agents list** under the Workspace list: every agent-mode pane, click is **Switch to**).
- `components/Explorer/` — File tree: `Explorer`, `FileTree`, `FileTreeItem`.
- `components/FileViewer/` — `FileViewerContainer`, `CodeEditor` (Monaco), `ImageViewer`, `UnsupportedFile`.
- `components/GitChanges/` — `GitChangesPanel`, `GitChangesFileList`, `GitChangesFileItem`, `DiffViewer`, `BranchSelector`, `PullRequestsSection`, `PullRequestItem`, `GitChangesResizer`, `GitPanelDivider`.
- `components/Search/` — `SearchPanel`, `SearchResultFile`, `SearchResultMatch`.
- `components/Notes/` — Per-workspace notes editor: `NotesPanel`, `NotesEditor`, `NotesToolbar`.
- `components/FileWindow/` — `FileWindowToolbar`, `MarkdownFindBar`, `FileWindowCloseConfirmDialog` (the owner's Save / Don't Save / Cancel). The root is `src/FileWindowApp.tsx`, rendered by `main.tsx` for `md-*` labels; it reads its kind from `file_window_info` and shows a text, image or diff view.
- `components/NewTask/` — `NewTaskDialog`: **New task** (describe a task or pick a GitHub issue; Restart agent / New tab / New worktree). Opened only through `lib/openNewTask.ts`.
- `components/FleetConsole/` — The **Fleet Console** (ADR-0040): `FleetConsole` (grid of every agent-mode pane in the Window), `FleetTile` (a borrowed `TerminalSlot` with `fleet` set), `GridPicker`, `NewAgentDialog`.
- `components/Navigator/` — The **Navigator** (`Navigator`): Workspace › Tab › Pane for this Window, with search, scope toggle and Agent status chips; each Workspace's open File windows are listed under it (`file_windows_list`, focused with `file_window_focus`). Rows come from the pure `lib/navigatorTree.ts`. Opened by the `open-navigator` action and the native Go ▸ Navigator… menu (`open-navigator` event, heard with `listenToThisWindow`).
- Top-level: `CommandPalette`, `FileSearchPalette`, `SettingsPanel`, `TabBar`, `StatusBar`, `Titlebar`, `OverviewBar`, `AppLoader`, `AgentStatusIcon`, `ConfirmDialog`, `SaveConfirmDialog`, `ErrorBoundary`, `LaunchPicker`, `NewWorkspaceDialog`, `OpenInDevEnvButton`, `DragPanePreview`, `PaneDropIndicator`.

#### Hooks

- `hooks/useSplitPane.ts` — Split, close, navigate pane operations.
- `hooks/usePty.ts` — PTY connection lifecycle.
- `hooks/useWorkspace.ts` — Workspace loading and management.
- `hooks/useConfirmCloseTerminalTab.ts` — Confirm dialog for unsaved terminal tabs.
- `hooks/useFileReloadWatcher.ts` — Watches open files for external changes and prompts reload.
- `hooks/useGitDataSync.ts` — Syncs git data for active and opened workspaces.
- `hooks/usePaneDrag.ts` — Drag-and-drop pane reordering logic.
- `hooks/useAgentPanes.ts` — Every agent-mode pane of the Window's Opened workspaces in derived order; feeds the Fleet Console (with its pending tiles) and the Agents list (without).
- `hooks/usePaneStatus.ts` — One pane's status icon state; shared by the pane title bar and the Agent row.

#### Stores

- `stores/workspaceStore.ts` — Workspaces, active layout, tabs, PTY statuses, focused pane. Has `updateLayoutLocal` (no DB) and `persistLayout` (DB only) for debounced resize.
- `stores/settingsStore.ts` — fontFamily, fontSize, theme, sidebarCollapsed, git panel width, sidebar split ratio, custom agents. Persists to localStorage (`abundio-settings`).
- `stores/explorerStore.ts` — File explorer state, open files, diff viewer support.
- `stores/gitChangesStore.ts` — Git changes tracking, branch info, caching.
- `stores/prStore.ts` — GitHub pull requests: review requests, user's PRs, view modes.
- `stores/searchStore.ts` — Full-text search state and results.
- `stores/ptyActivityStore.ts` — PTY activity tracking per workspace.
- `stores/agentRegistryStore.ts` — Detected agents available in `$PATH`.
- `stores/devEnvironmentsStore.ts` — Detected desktop IDE dev environments.
- `stores/workspaceGitStore.ts` — Per-workspace git summary (branch, change counts) for sidebar chips.
- `stores/workspaceEnvStore.ts` — Environment Bundles, variable metadata, and the **single** revealed-plaintext slot (one decrypted value at a time, by design).
- `stores/paneCloseConfirmStore.ts` — Confirm state for closing a pane.
- `stores/controlBadgeStore.ts` — The **Control badge**: which panes another Agent is driving right now, and by whom.
- `stores/agentSignalsStore.ts` — What Agents show the user about their own pane (ADR-0056): **Attention flags** and **Progress lines**. Per Window, in memory only.
- `stores/tabCloseConfirmStore.ts` — Confirm state for closing a tab.

#### Lib

- `lib/ipc.ts` — Typed wrappers around Tauri `invoke()` and `listen()`.
- `lib/themes.ts` — Built-in themes. `applyTheme()` sets CSS variables on `:root`.
- `lib/terminalManager.ts` — `ManagedTerminal` wraps xterm.js with FitAddon, SearchAddon, SerializeAddon, WebGL (canvas fallback). Handles PTY connection, scrollback restore, font updates, and `restartPanePty` (the third lifecycle path — ADR-0023).
- `lib/agentTitleMap.ts` — **Title status** (ADR-0047): per-Agent title rules (Mistral Vibe's `>> ` / `? ` prefixes and blurred-pane suffixes) and the pure `titleStep` decision. terminalManager feeds it `onTitleChange`.
- `lib/fleetConsole.ts` — Pure Fleet Console helpers: which panes are tiles and in what order, grid shape, Auto columns, divider drags, grid navigation.
- `lib/agentRowTitle.ts` — An Agent row's first line: the Agent's terminal title, or its name.
- `lib/handleOrder.ts` — Pure **Handle order** (Agents list, Agent cycle): Default handles by number. `lib/agentMenu.ts` — the **Agent menu**'s entries. `lib/agentCycle.ts` — the **Agent cycle**. `lib/agentPanes.ts` — the agent-mode panes from store values (shared by `useAgentPanes` and the Agent cycle) and `inHandleOrder`.
- `lib/leftSidebarLayout.ts` — Height split between the Workspace list and the Agents list.
- `lib/fleetFocus.ts` — `targetPaneId()`: the Focused tile in the Fleet Console, the Focused pane otherwise. Every pane-scoped shortcut resolves its target here; `workspaceViewOnly` mutes layout shortcuts in the console.
- `lib/paneLocation.ts` — `findPaneLocation`, `revealPane`, and `switchToPane` (the Fleet Console's **Switch to**).
- `lib/taskPrompt.ts` — Pure **New task** text: resolve a Task through the Task/Issue template, name its Tab, suggest a branch for an issue.
- `lib/newTask.ts` — Pure **New task** decisions: agent panes of a Workspace, the Restart agent target, default agent and destination, whether the shell supports a task launch.
- `lib/worktreePath.ts` — Branch validation and path resolution shared by the Add worktree and New task dialogs.
- `lib/sessionResume.ts` — **Session resume** (ADR-0050): per-folder Agent pane counts (the "alone" rule) and `relaunchCommandForPane`. `lib/agentSessionId.ts` reads each Agent's session id from its hook payload.
- `lib/workspaceRestore.ts` — **Workspace restore** (ADR-0052): fire-and-forget writes of a Profile's Opened list and Active workspace, plus the pure `pickActive`. The restore itself runs at the end of `loadWorkspaces`.
- `lib/missingFolder.ts` — **Missing folder** (ADR-0053): `folderMissingReason`, which recognises a spawn Rust refused for a Missing folder.
- `lib/paneRestart.ts` — `pickLivePanes` (pure) + `restartWorkspacePtys`: kill and respawn a Workspace's PTYs so they pick up a changed Injected bundle.
- `lib/agentControl/` — The Window side of **Agent control** (ADR-0054): `handleControlRequest.ts` answers `agent-control-request` (heard with `listenToThisWindow`, registered in `App.tsx` only); pure `resolveTarget`, `describe`, `readBuffer`, `settle` (when a wait is over), `keys` (send-keys bytes), `promptText`, `spawn` (split direction, start argv, run/close refusals), `crowding` (the crowded-Tab hint), `watchLines` (escape stripping and line matching for `pane watch`), `closeWorkspace` (what refuses `workspace close`); `waitForPane` watches a pane's status; `userSignals` (notify, the flag's clearing rules), `notesOps` (notes read/append/write/edit).
- `lib/notesText.ts` — Pure: a note's editor JSON as Markdown-like text (`**bold**`, `*italic*`, `~~strike~~`, `- [ ]` items, two-space nesting) and back. `editDoc` (`notes edit`) rebuilds only the paragraphs and list items its match touches, so the rest of the note keeps what text cannot express. `lib/notesEditors.ts` holds the open Notes editor per Workspace, so an Agent's change goes through it (one undoable step).
- `lib/hiddenSpawn.ts` — A new pane's PTY normally starts when it is first shown; `startUnlessShown` (via `terminalManager.startPtyUnlessShown`) starts it hidden when Agent control opens it where nobody is looking, or it would wait until the user went there. `TerminalPool` uses the same path to start every Watched Agent a just-Opened Workspace remembers, in every Tab, sized by `lib/hiddenAgentStart.ts` from the layout's split ratios.
- `lib/paneInput.ts` — Deliberate user input into a pane (terminalManager reports it; the Attention flag clears on it).
- `lib/agentHandle.ts` — **Agent handle** grammar and uniqueness; `handleForPane` for title bars.
- `lib/closePane.ts` — `closePaneNow`: the one close path, used by the confirmed close and by Agent control's `pane close` (`keepFocus`).
- `lib/openFileWindow.ts` — Every way into a File window goes through here; also the Cmd/Ctrl+click rule and `fileWindowTargetForPane` (the window shows what the pane shows). `lib/fileWindowKind.ts` is the pure name-based rule for which files have a File window.
- `lib/markdownLinks.ts` — Classifies a link click in rendered markdown (fragment / external / Workspace markdown / ignore). A plain `<a>` click would navigate the whole webview away from the app.
- `lib/fileWindowBuffer.ts` — Pure buffer transitions for a text File window (its own save echoing back vs. someone else's write).
- `lib/renderedFind.ts` — Find over rendered markdown, painted with the CSS Custom Highlight API.
- `lib/attentionCount.ts` — This Window's share of the **Attention count** (Waiting + Ready + Error PTYs), reported to Rust for the App icon badge.
- `lib/osc52.ts` — Parses OSC 52 clipboard payloads (write-only; reads are refused). See the clipboard convention below.
- `lib/mouseReporting.ts` — The DEC private modes that turn mouse reporting on, and the pure decisions around refusing them (swallow or not, badge state, sweep or replay). See ADR-0031.
- `lib/dotenvParse.ts` — Tolerant `.env` parser for the Bundle import dialog.
- `lib/snapshotRegistry.ts` — Registry of per-pane snapshot functions. `saveAllSnapshots()` persists all terminal scrollback.
- `lib/portalRegistry.ts` — Maps pane IDs to DOM elements for terminal rendering. Pub/sub pattern for target changes.
- `lib/keybindings.ts` — Keyboard shortcut registry with capture-phase interception. Defaults, action labels/categories, and the effective Keymap built from the user's Overrides.
- `lib/chords.ts` — Pure **Chord** helpers: record from a key event, spell, compare, vet (refuse/warn), and convert to Monaco keybindings and Tauri accelerators.
- `lib/keymapConflicts.ts` — Pure conflict check and recording plan for Settings ▸ Keyboard.
- `lib/monacoKeymap.ts` — Applies editor Overrides as Monaco keybinding rules (once per Window) and reads Monaco's action catalogue for Settings.
- `lib/agents.ts` — Built-in agent definitions (Claude Code, Copilot, Gemini, Codex, OpenCode, Qwen, Kimi, Grok, Vibe). `agentCommandFor()` is the single source of truth for an agent's launch string. `RETIRED_BUILTINS` lists built-ins a later release dropped (Aider); `mergeAgentsWithBuiltins` converts a Watched one into a custom Agent with the same id (ADR-0044).
- `lib/paneTree.ts` — Pure helper functions for pane tree traversal and manipulation.
- `lib/appWindow.ts` — `appWindow()` / `appWebview()` / `currentWindowLabel()`: the guarded way to reach Tauri's window APIs. `getCurrentWindow()` **throws** where there is no Tauri webview (the browser demo, jsdom), so never import it directly.
- `lib/platform.ts` — Platform detection (`isMac`).
- `lib/languageMap.ts` — File extension to Monaco language mapping.
- `lib/monacoShared.ts` — Shared Monaco editor configuration.
- `lib/nerdFonts.ts` — Nerd Font icon mappings for file explorer.
- `lib/shellIntegration.ts` — Shell integration helpers.
- `lib/activityGate.ts` — Activity detection gating logic.
- `lib/terminalResetFilter.ts` — Filters terminal reset sequences.
- `lib/base64.ts` — Base64 encoding/decoding utilities.
- `lib/unifiedDiff.ts` — Parses unified `.diff`/`.patch` files for the read-only diff viewer.
- `lib/types.ts` — Shared TypeScript type definitions.
- `lib/agentIcons.tsx` — Icon components for each supported agent.
- `lib/devEnvironments.ts` — IPC helpers and types for dev environment detection/launch.
- `lib/dragPaneHitTest.ts` — Hit-testing logic for drag-and-drop pane reordering.
- `lib/dragPaneStore.ts` — Ephemeral drag state (not a Zustand store — plain module).
- `lib/fuzzyMatch.ts` — Fuzzy matching utility for file quick-open.
- `lib/isMarkdownFile.ts` — Predicate for markdown file detection.
- `lib/markdownPrint.ts` — Markdown rendering helpers.
- `lib/notificationRouter.ts` — Routes Tauri notifications to the correct workspace.
- `lib/pendingAgentRegistry.ts` — Tracks agents awaiting PTY attachment.
- `lib/windowFocus.ts` — Window focus/blur detection for activity gating.
- `lib/demo/` — Demo/simulation mode (`VITE_ABUNDIO_DEMO=true`, run via `pnpm demo` / `pnpm demo:web`). `mockInvoke`/`mockListen` stand in for Tauri `invoke`/`listen`, serving in-memory `fixtures` and `transcripts` (real PTYs, git, GitHub, filesystem are never touched). `useDemoBootstrap` opens a curated set of workspaces on launch. `demo:web` runs in a plain browser, so anything reaching for a Tauri API must degrade: use `lib/appWindow.ts` for window/webview access and the `listen` exported from `lib/ipc.ts` (never `@tauri-apps/api/event` directly, which bypasses the mocks and throws).

### Data Flow

```
Terminal input → pty.write() IPC → crossbeam channel → OS thread → PTY stdin
PTY stdout → OS thread reads → base64 encode → Tauri event → xterm.write()
```

### Pane Layout

Panes use a recursive `PaneNode` tree stored as JSON in SQLite:

```typescript
type PaneNode =
  | { type: "terminal"; id: string; ptyId: string }
  | { type: "split"; id: string; direction: "horizontal" | "vertical"; ratio: number; first: PaneNode; second: PaneNode }
```

Workspaces support multiple tabs, each with its own `PaneNode` layout.

## Commands

```bash
pnpm tauri dev          # Run dev server (Vite + Tauri)
pnpm tauri build        # Build production binary
pnpm build              # TypeScript check + Vite build
pnpm test               # Vitest (all tests)
pnpm test -- path/to/file  # Run a single test file
pnpm check              # Biome lint/format check
pnpm check:fix          # Biome auto-fix
```

Rust requires `cargo` on PATH. If not found, it's at `~/.rustup/toolchains/stable-x86_64-apple-darwin/bin/cargo`.

```bash
cd src-tauri && cargo check              # Rust type check
cd src-tauri && cargo test               # Rust tests (all)
cd src-tauri && cargo test test_name     # Run a single Rust test
```

## CI/CD

GitHub Actions workflows in `.github/workflows/`:

- `build.yml` — Cross-platform build (macOS, Windows, Linux). Triggered by version tags.
- `test.yml` — Runs tests on PR and push.
- `pr-review.yml` — Automated PR review.
- `semgrep-security.yml` — Security scanning.

Releases are triggered by git tags:

```bash
pnpm run release 0.2.0        # bumps version, commits, creates v0.2.0 tag
git push --follow-tags         # triggers CI build for all platforms
```

## Key Conventions

- Rust errors use `AbundioError` enum (thiserror + Serialize). Never return `Result<T, String>`.
- PTY data is binary — base64 over IPC, `Uint8Array` in frontend. Never treat as UTF-8 strings.
- Resize events are debounced (100ms). Layout persists to DB only on mouseup, not during drag.
- Empty `ptyId` in a layout node means "spawn PTY on first render". TerminalPane handles this and writes the real ID back into the layout.
- Stale `ptyId`s are cleared on workspace load (those processes died with the previous app instance).
- Shell is spawned with `-l -i` flags (login + interactive) to source `.zshrc`. `TERM_PROGRAM=Abundio` is set.
- **Mouse reporting is allowed by default; the *Block mouse reporting* setting refuses it** (ADR-0031). When blocking, `lib/mouseReporting.ts` + hooks in `terminalManager` swallow mouse-mode DECSETs before xterm sees them, so `term.modes.mouseTrackingMode` stays `"none"` and ordinary selection, right-click and link hover keep working. DECSET is intercepted, **DECRST never is** — the asymmetry is load-bearing, or a mode that slipped through could never be turned off. A **mixed** DECSET (`?1049;1002h`) fails **open**: the parser hook is all-or-nothing and dropping an alt-screen switch is far worse than granting the mouse. `1004` (focus reporting) is not the mouse and is never blocked.
- **A TUI's own "copy" is OSC 52** (`ESC ] 52 ; c ; <base64>`), and xterm.js ships no handler for it — `lib/osc52.ts` + `installClipboardHook` carry it to the real clipboard. Programs print "copied to clipboard" the instant they emit it and never learn whether it landed, so a missing handler fails completely silently. **Clipboard *reads* (`Pd` of `?`) are refused outright** — honouring them turns any program, or any file someone `cat`s, into a clipboard exfiltration channel. Writes are skipped while `restoring`, or replayed scrollback would overwrite the clipboard at app start — the bare `restoring`, **not** the mouse hooks' `restoring && !restoreIsLive`, because a live PTY's log already delivered its write when those bytes were first produced. Text is normalised on the way out: CR becomes LF and the other C0 controls are stripped, since a bare CR on a system clipboard executes on paste into any shell without bracketed paste.
- **Lifting the block must replay.** A program asks for the mouse once, so un-blocking re-asserts the swallowed modes into xterm; without that, both the setting and the badge appear to do nothing until the program restarts. `wantedMouseModes` is cleared by `restartPanePty`; `mouseBlockOverride` deliberately is not.
- In a **mouse-reporting pane** (only reachable with blocking off), xterm disables its own selection service, so **Option+drag** (macOS) / **Shift+drag** (Win/Linux) is the only way to select text, and the **right button reaches the program** — reversing #170. The pane context menu is opened from the `⋯` button in the title bar, which is present in *every* pane so the menu is always reachable. Bare pointer movement is still withheld while a selection is up, or the walk to that button would clear it. Both guards stand down in panes with no mouse reporting, or they would starve xterm's Linkifier of hover. See the `Mouse-reporting pane`, `Mouse-blocked pane` and `Mouse badge` entries in `GLOSSARY.md`.
- **Every Tailwind `p-*` / `m-*` utility in this app is silently dead.** `globals.css:273` carries an unlayered `* { margin: 0; padding: 0 }` reset, and an unlayered *normal* declaration beats a layered one whatever its specificity — so `px-4`, `py-2`, `p-5` and the margin-based `space-x-*`/`space-y-*` all compute to `0`. **Set padding with an inline `style`**, as every existing component does (`ToggleRow`'s `padding: "10px 12px"`, `SettingsPanel`'s `"18px 22px 22px"`). `gap-*` is unaffected and works normally, which is what makes the breakage so easy to miss: a flex layout still looks spaced while every control inside it is flush to its own border. The one-line repair — wrapping that reset in `@layer base { … }` — is deferred for the app-wide layout sweep it would trigger. See the long note at `SettingsPanel.tsx:188`.
- **An inline `style` silently defeats `hover:` / `active:` / `focus:` utilities.** Inline declarations beat any class, so a button whose `color`, `backgroundColor` or `border` is set inline can never show a state change. Put the properties that change on hover or press in classes, and keep only sizing and padding inline (padding *must* stay inline, see above). Gate the states on `enabled:` so a disabled button stays still. `components/PromptActions/fieldStyles.ts` has `secondaryButtonClass` / `primaryButtonClass` to reuse.
- **Do not use a native `<select>`.** It is the one widget that ignores the theme: without `appearance: none` the platform draws it, and on Linux that is the GTK theme, which discards `background-color` and imposes its own text colour — pale-on-pale and barely readable. `appearance: none` fixes only the *closed* control; the open popup is an OS menu that CSS cannot reach at all. Use `components/PromptActions/Select.tsx`, which rebuilds both halves and portals the list so an ancestor's `overflow` cannot clip it.
- **A modal's Escape handler belongs on the card or on `document`, never on the backdrop.** The backdrop pattern (`onKeyDown={(e) => e.key === "Escape" && onCancel()}` on the overlay `div`) is dead code: the card inside calls `stopPropagation` so keystrokes cannot reach the terminal, and focus is placed inside the card on mount, so the event never reaches the backdrop. Use `hooks/useEscapeKey.ts`, which keeps a shared stack and dispatches only to the **topmost** overlay — a per-dialog `document` listener gets nesting backwards, because listeners on one node fire in registration order and mount order is outermost-first.
- **A pane can have several render targets.** `portalRegistry` and `promptActionRegistry` keep a stack per pane; the live entry is the highest priority, most recent. A Fleet tile registers at `FLEET_TILE_PRIORITY` over the pane's Workspace-view slot and hands the terminal back by unregistering its own element. Always unregister with the element/handlers you registered, never the bare pane id, or you remove the other slot's entry too (ADR-0040).
- **Re-parenting a terminal drops its keyboard focus.** `projectInto` (`TerminalInstance.tsx`) moves the xterm element with `appendChild` and hides it until painted; both blur it, and so does the `retract` to the holding container that comes first when a split replaces the old slot. So "did it have focus before the projection" is always no; don't test for it. `projectInto` instead gives focus to the revealed terminal when it is the target pane and focus is on `<body>` (`lib/projectionFocus.ts`); keep that if you touch projection.
- **WebGL glyph atlases are shared between terminals.** xterm's WebGL addon keeps one texture atlas per font/size/colour/DPR configuration and hands it to every terminal that matches (`acquireTextureAtlas`). `webglAddon.clearTextureAtlas()` on one terminal empties it for all of them, and only that one redraws — the others show cell backgrounds with no text. Never clear it for a single pane: use `clearGlyphCaches()` in `terminalManager` (clears on every WebGL terminal), or change an option that alters the configuration (font size), which acquires a fresh atlas by itself.
- **A New task never types its prompt** (ADR-0042). The PTY is spawned as `shell -i -c <script> <shell> <setup> <agent argv…>` with the prompt as one argv element, via `pendingAgentRegistry`'s `setPendingTask` → `pty_spawn`'s `task`. zsh and bash only; any other shell is refused and the pane falls back to a plain shell with the reason printed. The script reports the Agent on the `7770` channel itself, because shell integration never sees a `-c` command — without that, an exited Task Agent would stay in agent mode and relaunch on the next start. The prompt is not stored on the pane, so a relaunch never re-sends it.
- **Relaunched Agents resume their session** (ADR-0050). Every automatic relaunch line comes from `agentRelaunchCommandFor` (via `lib/sessionResume.ts`): the pane's `agentSessionId` by id, else `continueArgs` when the pane is the only one running that Agent in its launch folder, else the plain command. There is deliberately **no `|| <plain>` fallback**: it also fires when the user quits a resumed Agent with a non-zero exit (Copilot exits 1 on Ctrl+C). The id comes from a hook payload and is **typed into a shell**, so it must pass `isSafeSessionId` first (no shell syntax, and no leading `-`, which a resume flag with an optional value would read as an option). `setAgentId` drops the session whenever it clears or changes the Agent. **New task never resumes.** **The Orchestrator is the one exception** (ADR-0057): it starts through the PTY spawn (`lib/orchestratorLaunch.ts`), and a resume that fails within 20 s falls back to a plain start inside the spawn script.
- **A Profile reopens its Opened workspaces** (ADR-0052). `markWorkspaceOpened` is the one place that puts a Workspace on its Profile's restore list, and `closeWorkspace` takes it off by default. **Profile switch must call `closeWorkspace(id, { forget: false })`**, or every switch silently empties the old Profile's list. Closing a Window and quitting never go through `closeWorkspace`, so they keep the list. It is saved on every change, not at quit, so a crash restores too.
- **Nothing new starts in a Missing folder** (ADR-0053). `pty_spawn` looks up the Workspace's own folder: if it is missing the spawn is refused (`AbundioError::FolderMissing`, `Folder not found: <path>`), and if only the pane's remembered folder is gone it starts in the Workspace folder. **The home folder is never a fallback for a Workspace pane** — that is how an agent once relaunched silently in `~`. The pane prints the refusal and shows as exited; Restart retries. **`activeWorkspaceId` may name a Workspace that is not Opened**: a Missing-folder Workspace is shown as the "Folder not found" panel and `markWorkspaceOpened` refuses it. `missingFolderIds` is refreshed on load and on Window focus only.
- **Agent control trusts the per-pane token, nothing else** (ADR-0054). The caller of `/control` is whatever PTY its `ABUNDIO_AGENT_TOKEN` was issued to, and it reaches only that PTY's Profile (ADR-0055): its own Workspace by default, another named with `--workspace`, resolved and routed in Rust (`resolve_scope`), which also refuses other Profiles. The shared hook token (`ABUNDIO_HOOK_TOKEN`) is in every PTY and is **not** a pane boundary: never accept it on `/control`. Rust checks and routes; the owning Window carries the call out, so every new op needs a case in `handleControlRequest.ts`. Within that reach every pane is open to every call (`pane close` excepts the caller's own pane): ownership (**Spawned pane**) only labels helpers. A call that changes something is never retried after a dropped connection (`connection_lost`), except `prompt --wait`, which becomes a plain wait. Agent control moves keyboard focus only when asked (`--focus` on `pane split` and `agent start`) and never asks the user to confirm; the **Control badge** is how the user sees it.
- **A Tab opened by Agent control is created through `createTab`'s `spawn` option**, which writes the owner onto its pane (`spawnedBy`) before the Tab reaches the store; patching a new Tab's layout afterwards can overwrite its pane's `ptyId`. The `tabs.spawned_by_pane` and `tabs.user_named` columns are no longer used: any Tab may be renamed by an Agent.
- **Agents speak to the user only about their own pane, and only from agent mode** (ADR-0056). `notify`, `progress` and `worktree new` are refused (`agents_only`) from a plain shell. An **Attention flag** counts in the Attention count (`attentionCount`'s second argument) but is not a status, so it is never written into the status machine. `notify` pops at most one desktop notification a minute per pane. There is no `ask`: an Agent asks through its own question tool, which already shows Waiting. The CLI sends `X-Abundio-Request-Id` with every call and, when interrupted, a cancel for it (`X-Abundio-Cancel`), so a wait never outlives its call.
- **Every Agent has a handle, unique in its Profile, and Rust is the judge** (ADR-0055). A pane entering agent mode without one gets a Default handle from `agent_handle_default` (one `subscribeStatusChange` listener in `startAgentControl` is the only trigger; don't add per-launch-path calls). `setAgentHandle` is async because it asks `agent_handle_check`: each Window's copy of other Windows' layouts can be stale. Handles are matched by `handleKey` (case, spaces and dashes folded), the same in Rust and TS, tested against one shared table (`src/lib/__tests__/fixtures/handleGrammar.json`). A Window edits layouts only of Workspaces Opened in it; cross-Window effects (a closed owner pane) go through a Rust broadcast that each Window applies to its own Workspaces.
- Keybindings use capture phase (`addEventListener(..., true)`) to intercept before xterm.js.
- **The Keymap is defaults in code plus Overrides in `settingsStore`** (ADR-0043). `keybindings.ts` must not import the store: `App.tsx` pushes `keybindingOverrides` into `setKeybindingOverrides`, `applyMonacoOverrides` and the native menu's Settings… accelerator (`set_settings_accelerator`). Behaviour that is special-cased (save-file passing through to terminals, copy/paste deferring to text fields, gates) is keyed by **action id**, never by chord, so it follows a rebind.
- **Prompt action digit bindings are chosen to be invisible to the terminal**, not merely unused by Abundio. macOS `Cmd` is not a terminal modifier, so xterm never forwards a Cmd-chord to the PTY. On Windows/Linux `Ctrl+<digit>` is unusable (`Ctrl+2` is NUL, `Ctrl+3` is ESC, and so on across the row) and `Ctrl+Alt+<digit>` is unusable too, despite matching the split-pane precedent, because `Ctrl+Alt` **is AltGr** on European layouts. Hence `Ctrl+Shift+<digit>`.
- **Prompt actions live in SQLite, not `settingsStore`** (ADR-0039) — one row per action, because the in-pane popover makes writes frequent and multi-window and a whole-list broadcast loses appends. The change event is payload-free; receivers re-read. The `showActionBar` *preference* does live in `settingsStore`: the split is content vs. preference.
- **A Prompt action's interpolated parameter values are sanitised; its body is not.** The asymmetry is load-bearing and has named tests — a pasted value can carry `ESC[201~` (the `fileDrop.ts` injection through a new door), while the body is author-written and its newlines are the prompt.
- **`settingsStore` must never import `terminalManager`.** It reaches terminals through `lib/terminalSettingsBridge.ts`, which `terminalManager` registers with at the bottom of its module body. The app's module graph enters `terminalManager` first, so `persist` hydrates the settings store *during* that module's import phase — every top-level binding in `terminalManager` is still in the temporal dead zone, calling a setter throws `Cannot access ... before initialization`, and zustand swallows it, silently skipping the whole rehydrate handler. No amount of `setTimeout` fixes it; the bridge queues the pushes until registration.
- Themes apply to both CSS variables (UI) and xterm.js terminal options.
- The per-Pane state indicator is the **status icon** (component `AgentStatusIcon`) — call it a "status icon", never a "status dot". It renders as a spinner, chevron `>>>`, check, or coloured glyph depending on state/mode. See the `Status indicator` entry in `GLOSSARY.md`.
- macOS uses native titlebar with `titleBarStyle: "Overlay"` — content extends behind traffic lights. The React `Titlebar` component renders a 28px strip (`bg-secondary`) with the title text aligned to the traffic-light row.
- Cross-platform keybindings: `Cmd` on macOS, `Ctrl` on Windows/Linux.

## Environment variables (ADR-0024)

- Per-Workspace **Environment Bundles**. At most one is *injected* into every PTY; the rest are on-demand via the `abundio-env` helper. Enforced by a partial unique index, not a convention. **Zero injected is a valid state** — the bundle row's green injection toggle turns it off, so never invent an injected Bundle for a Workspace that carries no flag. The status-bar pill is a read-only indicator.
- **Plaintext never reaches the frontend except one variable at a time.** `env_list` returns names + byte lengths; `env_vars_reveal` is the only IPC that returns a value, and `workspaceEnvStore.revealed` is a single slot. Keep it that way.
- **A credential-store failure must never block a PTY spawn.** Degrade to an empty set, emit `env-vars-unavailable`, let the terminal open.
- **No `eval` in the wrapper rc scripts or `abundio-env`.** Values are arbitrary user data; the shadow-variable re-export uses `${(P)name}` (zsh) / `${!name}` + `printf -v` (bash), and the helper reads NUL-delimited records.
- **`docker compose --env-file` cannot read a process substitution** — it needs a regular seekable file and silently yields blank values. Use `abundio-env run <bundle> -- <cmd>`, which applies the Bundle to the child's environment.
- Variable names are validated in **Rust** (`env_crypto::validate_name`), not just the UI — the wrapper scripts are downstream of the IPC.

## Multi-window gotchas

The app spawns multiple Tauri windows at runtime — see ADR-0007 and ADR-0008. Several Tauri 2 / WKWebView behaviours bit us during implementation; capture them before next time:

- **Capabilities are scoped by window label.** Every window spawned programmatically must have its label listed in `src-tauri/capabilities/default.json`'s `windows` array or it gets **zero** permissions, and IPC/event calls (`listen`, `emit`, `getCurrentWindow().close()`, `dialog:allow-open`, `core:default`, etc.) silently fail. Patterns currently allowed: `main`, `window-*`, `settings` in `default.json`, and `md-*` in its own, narrower `markdown-window.json` (File windows render file content, so they get no shell execute, dialogs, notifications or clipboard read — only clipboard write, for code-block copy buttons). The app has no command manifest, so app commands stay callable from every window; only core and plugin permissions differ.
- **`PRAGMA foreign_keys` is a no-op inside a transaction.** Migrations that need FK enforcement disabled (e.g. table-rebuild patterns where a cascade-FK child table would lose data) must place the PRAGMA at the very start/end of the SQL. The migration framework (`migrations::apply_one` + `split_fk_pragmas`) extracts those statements and runs them outside the SAVEPOINT.
- **`RunEvent::ExitRequested` fires AFTER the last window's `Destroyed`**, not before, when triggered by Cmd+Q or `[NSApp terminate:]`. To run code *before* windows start tearing down on quit, use a custom Quit `MenuItem` (id `quit-app`) which routes through `on_menu_event` — see `lib.rs` and ADR-0007.
- **`localStorage` is isolated per Tauri webview on macOS.** Cross-window state sync cannot rely on the browser `storage` event. Use Tauri events (`emit`/`listen`) with the changed data shipped *in the payload*, then have receivers write to their own localStorage + call `useSettingsStore.persist.rehydrate()`. See `SettingsApp.tsx`.
- **DOM-measurement-derived CSS variables don't survive when the measuring component is unmounted.** When `CollapsedStrip` needs `--workspace-item-height` but the sidebar starts collapsed at launch (no `WorkspaceItem` mounted), the value is missing. Pattern: persist the last-measured value to localStorage and re-apply at module load — see `WorkspaceItem.tsx`.
- **Settings is its own OS-level window, not a modal.** Open it via the `open_settings_window` IPC, never a per-window `setSettingsOpen(true)`. Reading settings state from the settings window must NOT use `profileStore.loadProfiles()` (it pushes an `activeProfileId` claim into the per-window ownership map and pollutes it); fetch via `profilesApi.list()` + `setState` instead.
- **`emit_to(label, …)` does not isolate a global `listen`.** The JS `listen` from `lib/ipc.ts` has target `Any`, and Tauri delivers *every* event to an `Any` listener whatever the emit's target — so an event Rust aims at one Window (`switch-profile-request`, `pr-changes`, `update-available`, `whats-new`) reaches every Window. Hear those through `listenToThisWindow`, which listens on the current webview. This is how File → Switch Profile once raised the confirm dialog in every Window. On the Rust side, send them with `window_management::emit_to_one_profile_window` — never `app.emit` (a broadcast), and never a bare "focused window" pick, which can land on Settings and be dropped.
- **`md-*` is a third label family: the Workspace-bound File window** (ADR-0046, ADR-0049). The `md-` prefix dates from when these were Markdown windows and is kept on purpose: it keys each window's saved geometry and the capability file. Do not rename it, nor the `open-markdown-window` action id. `is_profile_window_label` excludes it, so it never claims a Profile, never lands in `windows.json` and never keeps the app alive. Its row is forgotten **only** by its own close handler; every owner-driven close (Workspace close, Profile switch, owning Window destroyed, quit) uses `destroy()`, which skips that handler, so the row stays and the window reopens with its Workspace. Its unsaved edits live in its own webview, so the owner asks Rust (`file_windows_dirty`) before closing.
- **Never trust tao's physical window positions across monitors** (tao#816). On macOS tao converts a window's position with the scale of the screen it is on *now*, and each monitor's rectangle with *its own* scale, so physical values from two screens with different scales are not in one coordinate system. `window_frame.rs` works in points on macOS and applies positions as `LogicalPosition`. Profile and File windows are placed by Abundio (ADR-0051); `tauri-plugin-window-state` only handles Settings. Every new Profile or File window must be built `.visible(false)` and shown through `place_and_show`, never `show()` — tao's `show()` makes the window key on macOS, which steals focus and would switch Space. One that shows without focus must also be built `.focused(false)`: that is how tao shows it without activating on Windows (`SW_SHOWNOACTIVATE`) and Linux, and a native `ShowWindow` would desync tao's own visible flag (its `set_focus` then does nothing, and its next style update hides the window). Restored Profile windows show together at the end of the launch restore (`show_launch_windows`), because wry activates the app on every webview it creates, and an active app with a visible window but no key window has AppKit make that window key — switching Space.
- **Tauri has no raise-without-focus.** The **File window raise** (a Workspace becoming Active brings its File windows up) goes through `window_raise.rs`; never use `set_focus()` for it, or every Workspace switch pulls keyboard focus out of the terminal. On a Workspace's first activation its windows are still being reopened by `file_windows_restore`, so the raise waits on that restore (`lib/fileWindowRaise.ts`) or it finds no windows.
- **Quit asks about unsaved edits from Rust.** Quit destroys Windows without a close request, so no frontend close handler runs. Each Profile window mirrors its unsaved File pane paths (`report_unsaved_files` → `UnsavedFilesState`), File windows report through `file_window_set_dirty`, and `quit-app` shows Save and Quit / Quit Without Saving / Cancel (`unsaved_edits.rs`). Menu Quit only, like the busy-work confirm.
- **A new window's `localStorage` may be empty or stale.** A File window calls `requestSettingsSnapshot()` on mount; every other window answers with its settings slice. The asker never answers itself, or its stale copy would reach everyone.
- **App-wide Tauri event listeners must be registered in every root.** Both `App.tsx` (Profile-bound windows) and `SettingsApp.tsx` (Settings window) need their own `listen("profile-ownership-changed", ...)` etc. — there's no implicit propagation between roots.
- **Cross-platform window-label assumptions.** New windows go through `window_management::generate_window_label()` (returns `window-<uuid>`). If you add a different label pattern, also update `is_profile_window_label`, the capabilities allowlist, and `windows.json` restoration filtering — these all depend on the predicate.
- **On-disk state is split by data epoch.** Anything an older build would fight over must go under `app_paths::versioned_root()`, not the shared root — the database, the shell-integration wrapper scripts, `pty-logs` and `windows.json` all do. Adding a new state file? Decide which side it belongs on. Note that `tauri-plugin-window-state` geometry and the webview's `localStorage` are keyed by *bundle identifier*, so they stay shared between co-installed builds.
- **The WebGL context budget is per-window, but the browser's limit may not be.** `MAX_WEBGL_CONTEXTS` (12) and the live count in `terminalManager.ts` are module state, so every window allows its own 12 — while on macOS Tauri's WKWebViews are expected to share one Web Content process, and the context limit (~16 in Chromium; WebKit does not document its own) is per process. Two windows with many workspaces open can therefore still push each other's terminal panes onto xterm's DOM renderer. Same shape of surprise as the master-key cache below, in the opposite direction: that cache is global where you'd expect per-window, this budget is per-window where you'd expect global.
- **The environment-variable master key cache is process-global**, not per-window, because a Tauri app is one process. `env_retry_key` therefore invalidates it for every window — which is the correct semantics for "the keychain was just unlocked", but means one window's Retry affects all of them.

## Testing

Unit tests are required when adding new functionality. Run tests before considering work complete.

- **Frontend**: Tests live in `__tests__/` directories co-located with source (e.g., `src/lib/__tests__/`). Use Vitest with jsdom. Mock Tauri IPC via `vi.mock("../ipc")`. Zustand stores are tested via `store.getState()`/`store.setState()`.
- **Rust**: Tests use inline `#[cfg(test)]` modules at the bottom of each source file. Use `Connection::open_in_memory()` for database tests. Run `crate::migrations::run_migrations(&conn)` before creating a `WorkspaceStore` in tests.
- Pure helper functions should be extracted into testable modules (e.g., `src/lib/paneTree.ts`) rather than kept as unexported file-local functions.

## Keyboard Shortcuts

Shortcuts use `Cmd` on macOS, `Ctrl` on Windows/Linux. These are the **defaults**; every one is rebindable in **Settings ▸ Keyboard** (ADR-0043). Never hardcode a shortcut in UI text — spell it with `useShortcutLabel(action)` / `shortcutLabelFor`, which follow the user's Overrides and return `""` when Unbound.

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Split horizontal | `Cmd+Shift+H` | `Ctrl+Alt+H` |
| Split vertical | `Cmd+Shift+V` | `Ctrl+Alt+V` |
| Close pane | `Cmd+Shift+W` | `Ctrl+Shift+W` |
| Copy (terminal) | `Cmd+C` (native) | `Ctrl+Shift+C` |
| Paste (terminal) | `Cmd+V` (native) | `Ctrl+Shift+V` |
| Focus pane on that side (Directional move) | `Cmd+Shift+Arrow` | `Ctrl+Shift+Arrow` |
| Next / previous pane (Pane cycle) | `Ctrl+Cmd+]` / `[` | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Next / previous Opened workspace | `Ctrl+Cmd+↓` / `↑` | `Ctrl+Shift+PageDown` / `PageUp` |
| Next / previous Agent (Agent cycle, Handle order) | `Ctrl+Cmd+→` / `←` | `Ctrl+Shift+End` / `Home` |
| Add worktree | `Cmd+Shift+B` | `Ctrl+Shift+B` |
| Command palette | `Cmd+K` | `Ctrl+K` |
| Navigator | `Cmd+J` | `Ctrl+Shift+J` |
| File quickopen | `Cmd+P` | `Ctrl+P` |
| Find in terminal | `Cmd+F` | `Ctrl+F` |
| Search workspace | `Cmd+Shift+F` | `Ctrl+Shift+F` |
| Toggle git panel | `Cmd+Shift+G` | `Ctrl+Shift+G` |
| Toggle explorer panel | `Cmd+Shift+E` | `Ctrl+Shift+E` |
| Toggle notes panel | `Cmd+Shift+K` | `Ctrl+Shift+K` |
| Toggle markdown preview | `Cmd+Shift+M` | `Ctrl+Shift+M` |
| Toggle Fleet Console | `Cmd+Shift+A` | `Ctrl+Shift+A` |
| Toggle Orchestrator view | `Cmd+Shift+O` | `Ctrl+Shift+O` |
| Spotlight focused tile / back to grid (Fleet Console only) | `Cmd+Shift+Enter` | `Ctrl+Shift+Enter` |
| Tile zoom in / out / reset (Fleet Console only) | `Cmd+=` / `Cmd+-` / `Cmd+0` | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| New workspace | `Cmd+Shift+N` | `Ctrl+Shift+N` |
| New tab | `Cmd+T` | `Ctrl+T` |
| New task | `Cmd+Shift+T` | `Ctrl+Shift+T` |
| Close tab | `Cmd+W` | `Ctrl+W` |
| Next tab | `Cmd+Shift+]` | `Ctrl+PageDown` |
| Previous tab | `Cmd+Shift+[` | `Ctrl+PageUp` |
| Increase font size | `Cmd+=` | `Ctrl+=` |
| Decrease font size | `Cmd+-` | `Ctrl+-` |
| Save file | `Cmd+S` | `Ctrl+S` |
| Open settings | `Cmd+,` | `Ctrl+,` |
| Fire prompt action 1–9 | `Cmd+1`–`Cmd+9` | `Ctrl+Shift+1`–`Ctrl+Shift+9` |
