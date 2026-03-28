# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Abundio is a GPU-accelerated terminal multiplexer desktop app built with Tauri v2. It manages sessions (each bound to a folder), supports split panes, and has first-class support for AI coding CLI agents (Claude Code, GitHub Copilot CLI, Gemini CLI, Aider, Codex, OpenCode).

## Tech Stack

- **Framework**: Tauri v2
- **Backend**: Rust (edition 2021) — `portable-pty`, `rusqlite`, `crossbeam-channel`, `dashmap`
- **Frontend**: React 19 + TypeScript 6 + Vite 8
- **Terminal**: `@xterm/xterm` 6.x with WebGL addon (canvas fallback)
- **State**: Zustand 5
- **Styling**: Tailwind CSS v4 (CSS variables for theming)
- **Linting**: Biome (tab indentation)
- **Package manager**: pnpm

## Architecture

### Rust Backend (`src-tauri/src/`)

- `pty_manager.rs` — Per-PTY dedicated OS threads with crossbeam channels. PTY types never cross async boundaries. Output is base64-encoded and emitted via Tauri events.
- `session_store.rs` — SQLite CRUD for sessions, layouts, env vars. DB at `~/Library/Application Support/abundio/abundio.db`.
- `agent_registry.rs` — Detects installed agents by scanning `$PATH` directories (no subprocess spawning).
- `commands.rs` — All `#[tauri::command]` handlers. All return `Result<T, AbundioError>`.
- `error.rs` — `AbundioError` enum (variants: `Pty`, `Db`, `Io`, `NotFound`, `Channel`) using thiserror + Serialize.
- `events.rs` — Event structs for PTY output (`PtyOutput` with base64 data) and status (`PtyStatus`: Running/Exited).
- `config.rs` — `AppConfig` struct (fontFamily, fontSize, theme). Defaults: "JetBrains Mono", 14pt, "default".
- `shell_env.rs` — `default_shell()`: reads `$SHELL` env var, falls back to `/bin/zsh`.
- `migrations.rs` — Auto-runs SQL migrations on startup, tracks applied in `_migrations` table.
- `lib.rs` — App entry with `Builder::setup()` that initializes DB, PTY manager, and agent registry via `app.manage()`.

### Frontend (`src/`)

- `components/Terminal/TerminalPane.tsx` — xterm.js instance with WebGL, PTY bridge, search bar, context menu.
- `components/Terminal/SplitContainer.tsx` — Recursive renderer for `PaneNode` tree.
- `hooks/useSplitPane.ts` — Split, close, navigate, maximize pane operations.
- `stores/sessionStore.ts` — Sessions, active layout, PTY statuses, focused pane. Has `updateLayoutLocal` (no DB) and `persistLayout` (DB only) for debounced resize.
- `lib/ipc.ts` — Typed wrappers around Tauri `invoke()` and `listen()`.
- `lib/themes.ts` — 5 built-in themes. `applyTheme()` sets CSS variables on `:root`.
- `lib/terminalManager.ts` — `ManagedTerminal` wraps xterm.js with FitAddon, SearchAddon, SerializeAddon, WebGL (canvas fallback). Handles PTY connection, scrollback restore, font updates.
- `lib/snapshotRegistry.ts` — Registry of per-pane snapshot functions. `saveAllSnapshots()` persists all terminal scrollback.
- `lib/portalRegistry.ts` — Maps pane IDs to DOM elements for terminal rendering. Pub/sub pattern for target changes.
- `stores/settingsStore.ts` — Zustand store for fontFamily, fontSize, theme, sidebarCollapsed. Persists to localStorage (`abundio-settings`).

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

## Commands

```bash
pnpm tauri dev          # Run dev server (Vite + Tauri)
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

## Key Conventions

- Rust errors use `AbundioError` enum (thiserror + Serialize). Never return `Result<T, String>`.
- PTY data is binary — base64 over IPC, `Uint8Array` in frontend. Never treat as UTF-8 strings.
- Resize events are debounced (100ms). Layout persists to DB only on mouseup, not during drag.
- Empty `ptyId` in a layout node means "spawn PTY on first render". TerminalPane handles this and writes the real ID back into the layout.
- Stale `ptyId`s are cleared on session load (those processes died with the previous app instance).
- Shell is spawned with `-l -i` flags (login + interactive) to source `.zshrc`. `TERM_PROGRAM=Abundio` is set.
- Keybindings use capture phase (`addEventListener(..., true)`) to intercept before xterm.js.
- Themes apply to both CSS variables (UI) and xterm.js terminal options.
- macOS uses native titlebar with `titleBarStyle: "Overlay"` — content extends behind traffic lights.

## Keyboard Shortcuts (macOS)

| Action | Shortcut |
|--------|----------|
| Split vertical | `Cmd+Shift+V` |
| Split horizontal | `Cmd+Shift+H` |
| Close pane | `Cmd+Shift+W` |
| Navigate panes | `Cmd+Shift+Arrow` |
| Maximize/restore | `Cmd+Shift+M` |
| Command palette | `Cmd+K` |
| Find in terminal | `Cmd+Shift+F` |
