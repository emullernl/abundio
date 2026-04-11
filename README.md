# Abundio

A GPU-accelerated terminal multiplexer desktop app built with [Tauri v2](https://v2.tauri.app). Abundio manages workspaces (each bound to a folder), supports split panes with tabs, and has first-class support for AI coding CLI agents like Claude Code, GitHub Copilot CLI, Gemini CLI, Aider, Codex, and OpenCode.

![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black)

## Features

- **GPU-accelerated rendering** — WebGL-powered terminal via xterm.js with canvas fallback
- **Split panes** — Horizontal and vertical splits with recursive nesting
- **Tabs** — Multiple tabs per workspace, each with its own pane layout
- **Workspace management** — Persistent workspaces tied to project directories, stored in SQLite
- **AI agent detection** — Automatically detects installed AI coding agents on your `$PATH`
- **Built-in code editor** — Monaco-powered editor for viewing and editing files
- **File explorer** — Tree view with Nerd Font icons, image preview, and file operations
- **Git integration** — Changed files panel, branch selector, inline diff viewer
- **GitHub PR panel** — Review requests and your PRs via GitHub CLI
- **Workspace search** — Full-text search across project files with cancellation
- **Theming** — Multiple built-in dark themes with live switching
- **Scrollback persistence** — Terminal scrollback is saved and restored across sessions
- **Native macOS integration** — Overlay titlebar with traffic light controls
- **Cross-platform** — macOS, Windows, and Linux support
- **Command palette** — Quick access to actions via `Cmd+K` / `Ctrl+K`

## Keyboard Shortcuts

Shortcuts use `Cmd` on macOS, `Ctrl` on Windows/Linux.

| Action              | macOS              | Windows/Linux       |
| ------------------- | ------------------ | ------------------- |
| Split horizontal    | `Cmd+Shift+H`     | `Ctrl+Shift+H`     |
| Split vertical      | `Cmd+Shift+V`     | `Ctrl+Shift+V`     |
| Close pane          | `Cmd+Shift+W`     | `Ctrl+Shift+W`     |
| Navigate panes      | `Cmd+Shift+Arrow`  | `Ctrl+Shift+Arrow` |
| Maximize/restore    | `Cmd+Shift+M`     | `Ctrl+Shift+M`     |
| Command palette     | `Cmd+K`           | `Ctrl+K`           |
| Find in terminal    | `Cmd+F`           | `Ctrl+F`           |
| Search workspace    | `Cmd+Shift+F`     | `Ctrl+Shift+F`     |
| Toggle git panel    | `Cmd+Shift+G`     | `Ctrl+Shift+G`     |
| New workspace       | `Cmd+Shift+N`     | `Ctrl+Shift+N`     |
| New tab             | `Cmd+T`           | `Ctrl+T`           |
| Close tab           | `Cmd+W`           | `Ctrl+W`           |
| Next tab            | `Cmd+Shift+]`     | `Ctrl+Shift+]`     |
| Previous tab        | `Cmd+Shift+[`     | `Ctrl+Shift+[`     |
| Increase font size  | `Cmd+=`           | `Ctrl+=`           |
| Decrease font size  | `Cmd+-`           | `Ctrl+-`           |
| Save file           | `Cmd+S`           | `Ctrl+S`           |
| Open settings       | `Cmd+,`           | `Ctrl+,`           |

## Prerequisites

- **Node.js** >= 18
- **pnpm** — `npm install -g pnpm`
- **Rust** — Install via [rustup](https://rustup.rs/)
- **Tauri v2 system dependencies** — See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform (Xcode Command Line Tools on macOS, `webkit2gtk` + `libappindicator` on Linux)

## Getting Started

```bash
# Clone the repo
git clone <repo-url> && cd abundio

# Install frontend dependencies
pnpm install

# Run in development mode (starts Vite dev server + Tauri app)
pnpm tauri dev
```

The app's SQLite database is created automatically at `~/Library/Application Support/abundio/abundio.db` on first launch.

## Building

To build a production binary:

```bash
pnpm tauri build
```

This compiles the Rust backend in release mode and bundles the frontend into a native application. Build artifacts are output to `src-tauri/target/release/bundle/`:

- **macOS**: `.dmg` and `.app` in `bundle/dmg/` and `bundle/macos/`
- **Windows**: `.msi` installer in `bundle/msi/` and `.exe` in `bundle/nsis/`
- **Linux**: `.deb` in `bundle/deb/` and `.AppImage` in `bundle/appimage/`

The first build takes several minutes while Cargo compiles all Rust dependencies in release mode. Subsequent builds are incremental.

## Development

### Commands

```bash
pnpm tauri dev              # Run dev server (Vite + Tauri)
pnpm tauri build            # Build production binary
pnpm build                  # TypeScript check + Vite build
pnpm test                   # Run all Vitest tests
pnpm test -- path/to/file   # Run a single test file
pnpm check                  # Biome lint/format check
pnpm check:fix              # Biome auto-fix
```

```bash
cd src-tauri && cargo check           # Rust type check
cd src-tauri && cargo test            # Run all Rust tests
cd src-tauri && cargo test test_name  # Run a single Rust test
```

### Project Structure

```
abundio/
├── src/                        # Frontend (React + TypeScript)
│   ├── components/
│   │   ├── Terminal/           # TerminalInstance, SplitContainer, TerminalPool
│   │   ├── Sidebar/            # Sidebar, WorkspaceList, WorkspaceItem
│   │   ├── Explorer/           # File tree browser
│   │   ├── FileViewer/         # CodeEditor (Monaco), ImageViewer
│   │   ├── GitChanges/         # Git panel, diff viewer, PR section
│   │   └── Search/             # Full-text workspace search
│   ├── hooks/                  # useSplitPane, usePty, useWorkspace
│   ├── lib/                    # ipc, themes, terminalManager, agents, keybindings
│   ├── stores/                 # Zustand stores (workspace, settings, git, search, explorer)
│   └── App.tsx
├── src-tauri/                  # Backend (Rust)
│   └── src/
│       ├── pty_manager.rs      # PTY lifecycle on dedicated OS threads
│       ├── workspace_store.rs  # SQLite CRUD for workspaces/layouts/tabs
│       ├── commands.rs         # Tauri command handlers
│       ├── file_explorer.rs    # File system operations
│       ├── file_watcher.rs     # File system watcher
│       ├── search.rs           # Full-text search with cancellation
│       ├── git_commands.rs     # Git operations
│       ├── gh_commands.rs      # GitHub CLI integration
│       ├── process_monitor.rs  # PTY process monitoring
│       ├── config.rs           # App configuration
│       ├── error.rs            # AbundioError enum
│       ├── events.rs           # PTY output/status events
│       ├── migrations.rs       # Auto-applied DB migrations
│       ├── shell_env.rs        # Default shell detection
│       └── lib.rs              # App entry point
├── .github/workflows/          # CI: build, test, PR review, security
├── CLAUDE.md                   # AI coding agent context
├── package.json
└── biome.json
```

### Tech Stack

| Layer    | Technology                                                       |
| -------- | ---------------------------------------------------------------- |
| Framework | Tauri v2                                                        |
| Backend  | Rust — portable-pty, rusqlite, crossbeam, dashmap, notify, ignore |
| Frontend | React 19, TypeScript 6, Vite 8                                  |
| Terminal | xterm.js 6.x with WebGL addon                                   |
| Editor   | Monaco Editor                                                    |
| State    | Zustand 5                                                        |
| Styling  | Tailwind CSS v4, Framer Motion                                   |
| Linting  | Biome (tab indentation)                                          |
| Package  | pnpm                                                             |

### Architecture Overview

**Data flow:**

```
Terminal input → pty.write() IPC → crossbeam channel → OS thread → PTY stdin
PTY stdout → OS thread reads → base64 encode → Tauri event → xterm.write()
```

PTY management runs on dedicated OS threads (not async) using crossbeam channels. PTY output is base64-encoded before crossing the IPC boundary. The frontend receives events and writes raw bytes to xterm.js.

**Pane layout** is a recursive tree stored as JSON in SQLite:

```
PaneNode = Terminal { id, ptyId }
         | Split { id, direction, ratio, first: PaneNode, second: PaneNode }
```

Each workspace supports multiple tabs, with each tab maintaining its own pane layout tree.

### Key Conventions

- Rust errors use the `AbundioError` enum (thiserror + Serialize) — never `Result<T, String>`
- PTY data is binary: base64 over IPC, `Uint8Array` in the frontend — never treat as UTF-8 strings
- Resize events are debounced (100ms); layout persists to DB only on mouseup
- Empty `ptyId` in a layout node means "spawn PTY on first render"
- Shell is spawned with `-l -i` flags (login + interactive) with `TERM_PROGRAM=Abundio`
- Keybindings use capture phase to intercept before xterm.js
- Cross-platform keybindings: `Cmd` on macOS, `Ctrl` on Windows/Linux
- Biome enforces tab indentation — run `pnpm check:fix` before committing

## Onboarding Guide for New Developers

### 1. Environment Setup

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install pnpm (if you don't have it)
npm install -g pnpm

# Install Xcode Command Line Tools (macOS)
xcode-select --install
```

### 2. Clone and Run

```bash
git clone <repo-url> && cd abundio
pnpm install
pnpm tauri dev
```

The first build will take a few minutes while Cargo compiles all Rust dependencies. Subsequent builds are incremental and much faster.

### 3. Where to Start Reading

1. **`CLAUDE.md`** — Full architecture reference. Read this first.
2. **`src-tauri/src/lib.rs`** — App bootstrap: DB init, PTY manager, agent registry, file watcher.
3. **`src-tauri/src/commands.rs`** — All IPC commands the frontend can call.
4. **`src/lib/ipc.ts`** — Frontend-side typed wrappers for those commands.
5. **`src/components/Terminal/TerminalInstance.tsx`** — The core terminal component.
6. **`src/stores/workspaceStore.ts`** — Central state for workspaces, tabs, and pane layout.

### 4. Common Tasks

**Adding a new Tauri command:**
1. Add the handler in `src-tauri/src/commands.rs` returning `Result<T, AbundioError>`
2. Register it in the `.invoke_handler()` call in `src-tauri/src/lib.rs`
3. Add a typed wrapper in `src/lib/ipc.ts`

**Adding a new theme:**
1. Define the theme object in `src/lib/themes.ts`
2. It will automatically appear in the settings UI

**Adding a DB migration:**
1. Add a new SQL statement to `src-tauri/src/migrations.rs`
2. Migrations auto-apply on app startup

### 5. Development Tips

- Use `pnpm check` before pushing to catch lint/format issues early
- The Tauri dev server supports hot reload for frontend changes; Rust changes require a recompile
- The SQLite database can be inspected directly at `~/Library/Application Support/abundio/abundio.db`
- If Cargo isn't on your PATH, it's at `~/.rustup/toolchains/stable-x86_64-apple-darwin/bin/cargo`

## Releasing

Releases are triggered by git tags. A helper script bumps the version in all config files, commits, and tags:

```bash
pnpm run release 0.2.0        # bumps version, commits, creates v0.2.0 tag
git push --follow-tags         # triggers CI build for all platforms
```

This creates a draft [GitHub Release](../../releases) with macOS, Linux, and Windows artifacts. Review the draft on GitHub and publish when ready.

## License

TBD
