# Plan: Markdown window raise

## Context

A **Markdown window** belongs to one Workspace (ADR-0046). It is a separate OS window, so when the user switches the **Active workspace** in a Profile-bound window, that Workspace's Markdown windows stay wherever they were, often buried under other windows. The user wants them to come forward on a switch.

The behaviour is defined in `GLOSSARY.md` under **Markdown window raise**. In short:

- It happens on **every** change of Active workspace, however it is caused (sidebar click, Workspace cycle, command palette, Fleet Console **Switch to**, New task, notification click, re-adding an existing folder). It also happens when the user **selects the already-Active Workspace again**.
- It is a **raise, not a focus**: the windows move up the stack, and keyboard focus stays in the Profile window.
- It only raises windows that are **visible on the current desktop**. Minimised windows stay minimised. Windows on another macOS Space (or another virtual desktop) stay there, so a switch never moves the user to another desktop.
- The Markdown windows of the Workspace being **left are not touched**.
- A Window gaining **OS focus** (Cmd+Tab back) is **not** a raise.
- It is **always on**, with no setting.
- On Windows/Linux it is **best effort**: if the platform refuses to raise a window without focusing it, the window stays put. It never takes focus.

### Facts found in the code

- Every user-driven switch goes through `beginWorkspaceSwitch` (`src/stores/workspaceStore.ts:822`), which ends in `setActiveWorkspace` (fast path at once, slow path two frames later). `createWorkspace` / `addWorktreeWorkspace` set `activeWorkspaceId` directly, but only for brand-new Workspaces, which have no remembered Markdown windows. The rule still applies to them, and the raise just finds nothing.
- Re-selecting the Active workspace hits the early return in `beginWorkspaceSwitch` (`id === get().activeWorkspaceId`), so it never reaches `setActiveWorkspace`.
- At launch `activeWorkspaceId` starts as `null`, and nothing activates a Workspace on its own (outside demo mode). So launch never triggers a raise, and the existing "restore opens behind" behaviour is unaffected.
- The **first** activation of a Workspace in a session also **reopens** its remembered windows: `markWorkspaceOpened` fires `useMarkdownWindowRestore` → `md_windows_restore`, which builds them with `focused(false)`. That IPC is still in flight when `activeWorkspaceId` changes, so the raise has to **wait for the restore** or it will find no windows.
- Tauri 2 has `set_focus()` but no "raise without focus" API. We need a little native code on each platform. The crates are already in `Cargo.lock` through Tauri: `objc2 0.6` / `objc2-app-kit 0.3` (macOS), `windows 0.61` (Windows), `gtk`/`gdk 0.18` (Linux).
- App commands are callable from every window (no command manifest), so `capabilities/*.json` needs no change.

## Changes

### 1. Rust: `md_windows_raise` command (`src-tauri/src/markdown_windows.rs`)

```rust
#[tauri::command]
pub async fn md_windows_raise(app, store, workspace_id: String) -> Result<(), AbundioError>
```

- Look up the Workspace's rows with `store.list_for_workspace`, then keep only labels whose window exists (`app.get_webview_window`). Put that filter in a **pure** function, `raisable_labels(rows, is_open: impl Fn(&str) -> bool) -> Vec<String>`, so it can be unit-tested.
- Call a new `window_raise::raise_without_focus(&app, &windows)`. Errors are logged, never returned: a raise that fails must not show the user an error.
- Register it in `lib.rs`'s `invoke_handler` next to `md_windows_restore`.

### 2. Rust: new `src-tauri/src/window_raise.rs`

One public function, `raise_without_focus(app, windows: &[WebviewWindow])`. The work runs inside `app.run_on_main_thread`, because AppKit and GTK window calls must run on the main thread.

- **macOS**: for each window, get `ns_window()` as an `NSWindow`. Skip it if `!isVisible()`, `isMiniaturized()` or `!isOnActiveSpace()`. Otherwise call `orderFront(None)`, which raises the window without making it the key window (the one that gets keyboard input). To keep the windows' order among themselves, raise them back-to-front in the order of `NSApp.orderedWindows` (frontmost first, so iterate it reversed).
- **Windows**: `hwnd()`. Skip it if `IsIconic` or `!IsWindowVisible`. Otherwise call `SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)`. This never switches virtual desktop, so no desktop check is needed.
- **Linux**: `gtk_window()` → `gdk::Window`. Skip it if not visible or if its state has `ICONIFIED`. Otherwise call `raise()`. This works on X11. On Wayland the compositor usually ignores it, which is the agreed "best effort, stays put".
- New direct dependencies, each limited to its target and pinned to the version Tauri already uses, so no new crates are downloaded:
  - `[target.'cfg(target_os = "macos")'.dependencies]`: `objc2`, `objc2-app-kit` (features `NSWindow`, `NSApplication`, `NSResponder`)
  - `[target.'cfg(windows)'.dependencies]`: `windows` (features `Win32_Foundation`, `Win32_UI_WindowsAndMessaging`)
  - `[target.'cfg(target_os = "linux")'.dependencies]`: `gtk`
  - Add a comment for each, in the style of the existing `Cargo.toml` notes.
- Add the module to the Rust architecture list in `CLAUDE.md`.

### 3. Frontend IPC (`src/lib/ipc.ts`, `src/lib/demo/mockInvoke.ts`)

- `markdownWindows.raise(workspaceId)` → `invoke<void>("md_windows_raise", { workspaceId })`.
- Demo: add `case "md_windows_raise": return undefined;`.

### 4. Make restore and raise run in order (new `src/lib/markdownWindowRaise.ts`)

- Keep a module-level `Map<workspaceId, Promise<void>>` of in-flight restores. `restoreMarkdownWindows(id)` wraps `markdownWindows.restore(id)`, stores the promise, and removes it when it settles. `useMarkdownWindowRestore` calls this instead of the IPC directly.
- `afterRestore(workspaceId)` returns the pending promise (errors swallowed), or a resolved one if there is none.
- `raiseMarkdownWindows(workspaceId)` = `afterRestore(id).then(() => markdownWindows.raise(id)).catch(log)`.
- This lives in `lib/`, not in the hook, because the workspace store calls it too (step 6), and a store should not import a hook.

### 5. New hook `src/hooks/useMarkdownWindowRaise.ts`

- Subscribes to `useWorkspaceStore` and calls `raiseMarkdownWindows` whenever `activeWorkspaceId` changes to a **non-null** id. A change to `null` (closing the Active workspace, a Profile switch) does nothing.
- Call it from `App.tsx` next to `useMarkdownWindowRestore()`. Profile-bound windows only: `SettingsApp` and `MarkdownWindowApp` never switch Workspaces.

### 6. Re-select raises too (`src/stores/workspaceStore.ts`)

- In the `id === get().activeWorkspaceId` early return of `beginWorkspaceSwitch`, call `raiseMarkdownWindows(id)` (when `id` is non-null) before returning.
- Check the slow-path race: a switch A→B that is superseded by B→A within two frames lands in the early return. It raises A's windows, which is right because A is what the user ended on.

### 7. Docs

- `GLOSSARY.md`: **Markdown window raise** (already written).
- `CLAUDE.md` → *Multi-window gotchas*: one bullet saying Tauri has no raise-without-focus, so `window_raise.rs` has per-platform code; never use `set_focus()` for a raise; a raise on a Workspace's first activation must wait for its restore.
- No ADR: the behaviour is easy to undo and has no real architectural trade-off.

## Tests

- **Rust** (`markdown_windows.rs`): `raisable_labels` returns only the open windows of the given Workspace, and returns nothing for a Workspace that has no rows.
- **Frontend** (`src/hooks/__tests__/useMarkdownWindowRaise.test.tsx`, with `vi.mock("../../lib/ipc")`):
  - A change of `activeWorkspaceId` to an id calls `raise` once, with that id.
  - A change to `null` does not call `raise`.
  - `beginWorkspaceSwitch` with the Active id calls `raise`.
  - When a restore is pending for the id, `raise` is called only after it resolves (a restore promise you control).
  - A rejected `raise` is logged, not thrown.
- `afterRestore` resolves after the pending restore, and at once when there is none (same file).

## Manual check (macOS first, then Windows/Linux if available)

Unit tests cannot see window stacking (see memory: *verify runtime, not just tests*):

1. Workspace A has two Markdown windows. Bury them under another app's window, switch to B, then back to A: both come up above the other app, in their old order, and typing goes to the terminal.
2. Click A again while it is Active: its windows come up.
3. Minimise one of A's windows and switch to A: it stays minimised, and the other one comes up.
4. Move one of A's windows to another Space and switch to A from the first Space: no Space change.
5. Quit with A holding remembered windows, relaunch, activate A for the first time: its windows reopen **and** come up.
6. Cmd+Tab away and back: no raise beyond what macOS itself does.
7. Two Profile windows: a switch in one never raises the other Profile's Markdown windows.

## Commits (one branch, `feat/markdown-window-raise`)

1. Rust: `window_raise.rs` + dependencies + `md_windows_raise` + `raisable_labels` tests.
2. Frontend: IPC + demo mock, `afterRestore`, `useMarkdownWindowRaise`, re-select hook, tests.
3. Docs: `CLAUDE.md` bullet and module list (the glossary entry goes in with this commit too).
