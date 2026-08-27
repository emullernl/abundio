# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Abundio is a GPU-accelerated terminal multiplexer desktop app built with Tauri v2. It manages workspaces (each bound to a folder), supports split panes with tabs, and has first-class support for AI coding CLI agents (Claude Code, GitHub Copilot CLI, Gemini CLI, Aider, Codex, OpenCode, Qwen Code, Kimi Code, Grok Build). It includes a built-in file explorer, code editor (Monaco), git integration, GitHub PR panel, and full-text workspace search.

> **Domain language**: see `CONTEXT.md` for canonical term definitions (Workspace, Pane, PTY, Tab, Agent, etc.) and flagged ambiguities to avoid.

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
- `commands.rs` — All `#[tauri::command]` handlers. All return `Result<T, AbundioError>`.
- `error.rs` — `AbundioError` enum (variants: `Pty`, `Db`, `Io`, `NotFound`, `Channel`) using thiserror + Serialize.
- `events.rs` — Event structs for PTY output (`PtyOutput` with base64 data) and status (`PtyStatus`: Running/Exited).
- `config.rs` — `AppConfig` struct (fontFamily, fontSize, theme). Defaults: "JetBrains Mono", 14pt, "default".
- `shell_env.rs` — `default_shell()`: reads `$SHELL` env var, falls back to `/bin/zsh`.
- `migrations.rs` — Auto-runs SQL migrations on startup, tracks applied in `_migrations` table.
- `file_explorer.rs` — File system operations: list directory, read/write files, check existence.
- `file_watcher.rs` — File system watcher (notify crate) initialized on app setup.
- `search.rs` — Full-text workspace search with cancellation support (`fs_search`, `fs_search_cancel`).
- `git_commands.rs` — Git operations: changed files, file diffs, branch info, list branches, status fingerprint.
- `gh_commands.rs` — GitHub CLI integration: PR status, review requests, user's PRs.
- `dev_environments.rs` — Desktop IDE detection and launch (VS Code, Cursor, JetBrains, etc.). Pure Rust, no app state.
- `process_monitor.rs` — Process monitoring for PTY child processes.
- `lib.rs` — App entry with `Builder::setup()` that initializes DB, PTY manager, agent registry, and file watcher via `app.manage()`.

### Frontend (`src/`)

#### Components

- `components/Terminal/` — Terminal pane system: `TerminalInstance`, `TerminalSlot`, `TerminalPool`, `SplitContainer`, `TerminalTitleBar`, `PaneResizer`, `SearchBar`, `PaneContextMenu`, `DebugActivityMeter`.
- `components/Sidebar/` — `Sidebar`, `WorkspaceList`, `WorkspaceItem`.
- `components/Explorer/` — File tree: `Explorer`, `FileTree`, `FileTreeItem`.
- `components/FileViewer/` — `FileViewerContainer`, `CodeEditor` (Monaco), `ImageViewer`, `UnsupportedFile`.
- `components/GitChanges/` — `GitChangesPanel`, `GitChangesFileList`, `GitChangesFileItem`, `DiffViewer`, `BranchSelector`, `PullRequestsSection`, `PullRequestItem`, `GitChangesResizer`, `GitPanelDivider`.
- `components/Search/` — `SearchPanel`, `SearchResultFile`, `SearchResultMatch`.
- `components/Notes/` — Per-workspace notes editor: `NotesPanel`, `NotesEditor`, `NotesToolbar`.
- Top-level: `CommandPalette`, `FileSearchPalette`, `SettingsPanel`, `TabBar`, `StatusBar`, `Titlebar`, `OverviewBar`, `AppLoader`, `AgentStatusIcon`, `ConfirmDialog`, `SaveConfirmDialog`, `ErrorBoundary`, `LaunchPicker`, `NewWorkspaceDialog`, `OpenInDevEnvButton`, `DragPanePreview`, `PaneDropIndicator`.

#### Hooks

- `hooks/useSplitPane.ts` — Split, close, navigate pane operations.
- `hooks/usePty.ts` — PTY connection lifecycle.
- `hooks/useWorkspace.ts` — Workspace loading and management.
- `hooks/useConfirmCloseTerminalTab.ts` — Confirm dialog for unsaved terminal tabs.
- `hooks/useFileReloadWatcher.ts` — Watches open files for external changes and prompts reload.
- `hooks/useGitDataSync.ts` — Syncs git data for active and opened workspaces.
- `hooks/usePaneDrag.ts` — Drag-and-drop pane reordering logic.

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
- `stores/tabCloseConfirmStore.ts` — Confirm state for closing a tab.

#### Lib

- `lib/ipc.ts` — Typed wrappers around Tauri `invoke()` and `listen()`.
- `lib/themes.ts` — Built-in themes. `applyTheme()` sets CSS variables on `:root`.
- `lib/terminalManager.ts` — `ManagedTerminal` wraps xterm.js with FitAddon, SearchAddon, SerializeAddon, WebGL (canvas fallback). Handles PTY connection, scrollback restore, font updates, and `restartPanePty` (the third lifecycle path — ADR-0023).
- `lib/paneRestart.ts` — `pickLivePanes` (pure) + `restartWorkspacePtys`: kill and respawn a Workspace's PTYs so they pick up a changed Injected bundle.
- `lib/dotenvParse.ts` — Tolerant `.env` parser for the Bundle import dialog.
- `lib/snapshotRegistry.ts` — Registry of per-pane snapshot functions. `saveAllSnapshots()` persists all terminal scrollback.
- `lib/portalRegistry.ts` — Maps pane IDs to DOM elements for terminal rendering. Pub/sub pattern for target changes.
- `lib/keybindings.ts` — Keyboard shortcut registry with capture-phase interception.
- `lib/agents.ts` — Built-in agent definitions (Claude Code, Copilot, Gemini, Aider, Codex, OpenCode, Qwen, Kimi, Grok). `agentCommandFor()` is the single source of truth for an agent's launch string.
- `lib/paneTree.ts` — Pure helper functions for pane tree traversal and manipulation.
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
- `lib/demo/` — Demo/simulation mode (`VITE_ABUNDIO_DEMO=true`, run via `pnpm demo` / `pnpm demo:web`). `mockInvoke`/`mockListen` stand in for Tauri `invoke`/`listen`, serving in-memory `fixtures` and `transcripts` (real PTYs, git, GitHub, filesystem are never touched). `useDemoBootstrap` opens a curated set of workspaces on launch.

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
- Keybindings use capture phase (`addEventListener(..., true)`) to intercept before xterm.js.
- Themes apply to both CSS variables (UI) and xterm.js terminal options.
- The per-Pane state indicator is the **status icon** (component `AgentStatusIcon`) — call it a "status icon", never a "status dot". It renders as a spinner, chevron `>>>`, check, or coloured glyph depending on state/mode. See the `Status indicator` entry in `CONTEXT.md`.
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

- **Capabilities are scoped by window label.** Every window spawned programmatically must have its label listed in `src-tauri/capabilities/default.json`'s `windows` array or it gets **zero** permissions, and IPC/event calls (`listen`, `emit`, `getCurrentWindow().close()`, `dialog:allow-open`, `core:default`, etc.) silently fail. Patterns currently allowed: `main`, `window-*`, `settings`.
- **`PRAGMA foreign_keys` is a no-op inside a transaction.** Migrations that need FK enforcement disabled (e.g. table-rebuild patterns where a cascade-FK child table would lose data) must place the PRAGMA at the very start/end of the SQL. The migration framework (`migrations::apply_one` + `split_fk_pragmas`) extracts those statements and runs them outside the SAVEPOINT.
- **`RunEvent::ExitRequested` fires AFTER the last window's `Destroyed`**, not before, when triggered by Cmd+Q or `[NSApp terminate:]`. To run code *before* windows start tearing down on quit, use a custom Quit `MenuItem` (id `quit-app`) which routes through `on_menu_event` — see `lib.rs` and ADR-0007.
- **`localStorage` is isolated per Tauri webview on macOS.** Cross-window state sync cannot rely on the browser `storage` event. Use Tauri events (`emit`/`listen`) with the changed data shipped *in the payload*, then have receivers write to their own localStorage + call `useSettingsStore.persist.rehydrate()`. See `SettingsApp.tsx`.
- **DOM-measurement-derived CSS variables don't survive when the measuring component is unmounted.** When `CollapsedStrip` needs `--workspace-item-height` but the sidebar starts collapsed at launch (no `WorkspaceItem` mounted), the value is missing. Pattern: persist the last-measured value to localStorage and re-apply at module load — see `WorkspaceItem.tsx`.
- **Settings is its own OS-level window, not a modal.** Open it via the `open_settings_window` IPC, never a per-window `setSettingsOpen(true)`. Reading settings state from the settings window must NOT use `profileStore.loadProfiles()` (it pushes an `activeProfileId` claim into the per-window ownership map and pollutes it); fetch via `profilesApi.list()` + `setState` instead.
- **App-wide Tauri event listeners must be registered in every root.** Both `App.tsx` (Profile-bound windows) and `SettingsApp.tsx` (Settings window) need their own `listen("profile-ownership-changed", ...)` etc. — there's no implicit propagation between roots.
- **Cross-platform window-label assumptions.** New windows go through `window_management::generate_window_label()` (returns `window-<uuid>`). If you add a different label pattern, also update `is_profile_window_label`, the capabilities allowlist, and `windows.json` restoration filtering — these all depend on the predicate.
- **On-disk state is split by data epoch.** Anything an older build would fight over must go under `app_paths::versioned_root()`, not the shared root — the database, the shell-integration wrapper scripts, `pty-logs` and `windows.json` all do. Adding a new state file? Decide which side it belongs on. Note that `tauri-plugin-window-state` geometry and the webview's `localStorage` are keyed by *bundle identifier*, so they stay shared between co-installed builds.
- **The environment-variable master key cache is process-global**, not per-window, because a Tauri app is one process. `env_retry_key` therefore invalidates it for every window — which is the correct semantics for "the keychain was just unlocked", but means one window's Retry affects all of them.

## Testing

Unit tests are required when adding new functionality. Run tests before considering work complete.

- **Frontend**: Tests live in `__tests__/` directories co-located with source (e.g., `src/lib/__tests__/`). Use Vitest with jsdom. Mock Tauri IPC via `vi.mock("../ipc")`. Zustand stores are tested via `store.getState()`/`store.setState()`.
- **Rust**: Tests use inline `#[cfg(test)]` modules at the bottom of each source file. Use `Connection::open_in_memory()` for database tests. Run `crate::migrations::run_migrations(&conn)` before creating a `WorkspaceStore` in tests.
- Pure helper functions should be extracted into testable modules (e.g., `src/lib/paneTree.ts`) rather than kept as unexported file-local functions.

## Keyboard Shortcuts

Shortcuts use `Cmd` on macOS, `Ctrl` on Windows/Linux.

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Split horizontal | `Cmd+Shift+H` | `Ctrl+Alt+H` |
| Split vertical | `Cmd+Shift+V` | `Ctrl+Alt+V` |
| Close pane | `Cmd+Shift+W` | `Ctrl+Shift+W` |
| Copy (terminal) | `Cmd+C` (native) | `Ctrl+Shift+C` |
| Paste (terminal) | `Cmd+V` (native) | `Ctrl+Shift+V` |
| Navigate panes | `Cmd+Shift+Arrow` | `Ctrl+Shift+Arrow` |
| Command palette | `Cmd+K` | `Ctrl+K` |
| File quickopen | `Cmd+P` | `Ctrl+P` |
| Find in terminal | `Cmd+F` | `Ctrl+F` |
| Search workspace | `Cmd+Shift+F` | `Ctrl+Shift+F` |
| Toggle git panel | `Cmd+Shift+G` | `Ctrl+Shift+G` |
| Toggle explorer panel | `Cmd+Shift+E` | `Ctrl+Shift+E` |
| Toggle notes panel | `Cmd+Shift+K` | `Ctrl+Shift+K` |
| Toggle markdown preview | `Cmd+Shift+M` | `Ctrl+Shift+M` |
| New workspace | `Cmd+Shift+N` | `Ctrl+Shift+N` |
| New tab | `Cmd+T` | `Ctrl+T` |
| Close tab | `Cmd+W` | `Ctrl+W` |
| Next tab | `Cmd+Shift+]` | `Ctrl+Shift+]` |
| Previous tab | `Cmd+Shift+[` | `Ctrl+Shift+[` |
| Increase font size | `Cmd+=` | `Ctrl+=` |
| Decrease font size | `Cmd+-` | `Ctrl+-` |
| Save file | `Cmd+S` | `Ctrl+S` |
| Open settings | `Cmd+,` | `Ctrl+,` |
