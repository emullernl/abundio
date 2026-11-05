# Window placement

Remember and restore each window's **Window placement**: its monitor, its spot on that monitor, its size, whether it is maximised or fullscreen, and its desktop. This covers Profile-bound windows and File windows. See `GLOSSARY.md` (**Window placement**) and ADR-0051.

## Why

`tauri-plugin-window-state` saves positions in physical pixels and records no monitor. On macOS, tao (the windowing layer under Tauri) converts those pixels using the scale of the screen the window is on *at that moment*. A window saved on a 1× external monitor and restored next to a 2× Retina screen therefore lands at half the coordinates, at half the size (tao#816). Desktops are not saved at all.

## Decisions (from the design session)

| Topic | Decision |
|-------|----------|
| Windows covered | Profile-bound (`main`, `window-*`) and File windows (`md-*`). Settings keeps the plugin. |
| Platforms | macOS, Windows and Linux together. |
| Monitor identity | Recognised by name. Two monitors with the same name are told apart by their place in the display arrangement. |
| Position | Logical units, relative to the monitor's top-left corner. If the monitor shrank, the window is clamped to fit. |
| Missing monitor | The window opens on the main display at the same relative spot, shrunk to fit if needed. The remembered monitor is kept until the user moves the window. |
| Old data | On the first launch after the update, read `.window-state.json` once as a best guess. |
| Storage | Profile windows: `windows.json` (an extra `placement` field on each entry). File windows: new columns on their `file_windows` row. |
| Desktop: when | At app start only. A File window reopened with its Workspace later in a session opens on the current desktop. |
| Desktop: focus | Restoring never switches the user's desktop. Restored windows are shown without being activated. |
| Missing desktop | The window opens on the current desktop. The remembered desktop is kept until the user moves the window. |
| Fullscreen | Comes back fullscreen on its monitor. |
| macOS desktop | Chrome's restore-state method (one private method). Prototype first. If the prototype fails, macOS ships with monitors only. |
| Windows desktop | The public `IVirtualDesktopManager` (`GetWindowDesktopId` / `MoveWindowToDesktop`). |
| Linux desktop | X11 `_NET_WM_DESKTOP`. On Wayland, only size and maximised state come back. |

## Steps (ordered commits on one branch, `window-placement`)

### 0. macOS prototype (gate)

A standalone Objective-C app in `prototypes/space-restore/`, not part of the build. It:

1. Opens a window. You move it to another desktop and click **Save**.
2. Saves the window's restorable state (`encodeRestorableStateWithCoder:` into an `NSKeyedArchiver` that skips views).
3. Relaunches with the saved state. It replays the state onto a new, hidden window with `restoreStateWithCoder:`, using a decoder that implements `_windowRestorationOptions`, then shows the window without activating it.
4. Also offers a control run without the private method, to show the method is what does the work.

**Pass:** on macOS 26.7.1, the restored window appears on the desktop it was saved on, while you stay on desktop 1.

**Result (2026-11-05, macOS 26.7.1, SIP on): PASS.** Saved on desktop 2, relaunched from desktop 1:

- Control (no private method): the window opened on desktop 1 (`onActiveSpace=1`).
- With `_windowRestorationOptions`: AppKit asked for the method, found `NSWindowRestorationOptions`, and put the window on desktop 2 (`onActiveSpace=0`). The frame was restored exactly, and the user stayed on desktop 1.

Lessons for the Rust port:

- Archive with `initRequiringSecureCoding:YES`. Decode with `initForReadingFromData:error:` and leave secure coding on: AppKit's restore *asserts* (SIGABRT in `-[NSCoder _secureStateRestorationCoder]`) on a decoder with `requiresSecureCoding = NO`.
- Keep `applicationSupportsSecureRestorableState` answering YES (tao already does).
- Show with `orderWindow:NSWindowBelow relativeTo:0`, never `makeKeyAndOrderFront:`.

### 1. Placement model (pure Rust, `window_placement.rs`)

- `WindowPlacement { monitor: MonitorKey, rel_x, rel_y, width, height (logical), maximized, fullscreen, desktop: Option<DesktopKey> }`.
- `MonitorKey { name, arrangement_index }`.
- `MonitorInfo { name, logical_rect, scale }`, built from tao's monitor list. The rectangles are converted to logical units per monitor, because tao reports each one in its own scale.
- Pure functions, each unit-tested:
  - `capture(window_logical_rect, monitors) -> WindowPlacement`: pick the monitor holding the window's centre.
  - `resolve(placement, monitors) -> (monitor, logical_rect)`: match by name, then by arrangement index; fall back to the main display; clamp and shrink to fit.
  - `from_legacy(plugin_entry, monitors)`: one-time guess from the old file.

### 2. Platform glue: read and apply the frame

- On macOS, read the frame from `NSWindow.frame` in points, not through tao's `outer_position` (which is buggy). On Windows and Linux, use tao's logical outer position.
- Apply the frame with `set_position(LogicalPosition)` first, then `set_size(LogicalSize)`, before the window is shown. Windows are built with `.visible(false)` and shown after the restore.
- Maximised and fullscreen are applied after the frame.

### 3. Saving

- Capture on `Moved` and `Resized` (debounced), and before destroy or quit.
  - Profile windows: kept in memory, written with the existing `windows.json` save.
  - File windows: written to the row.
- Each window remembers `Remembered { home, away }` (`window_placement::remember` / `choose`). A capture while home's monitor is not connected goes to `away`, so the OS moving windows off an unplugged monitor, mid-session or not, never loses home. This replaces the "kept until the user moves it" idea, which would need telling user moves from OS moves.
- `window_frame::PlacementTracker` (managed state) keeps each tracked window's `Remembered` in memory. `track(window)` records on every `Moved`/`Resized` (skipped while minimised), starting only after the window is placed.
- Written out: Profile windows through `snapshot_from_state` into `windows.json`; File windows into a `placement` JSON column (migration 019) in `on_destroyed`.

### 4. Hook up both window kinds

- `window_management::open_window_with_profile_and_label`, the `main` window from `tauri.conf.json` (make it start hidden), and `file_windows::build_window`.
- Add `md-*` and `window-*`/`main` to the plugin's denylist (`Builder::with_denylist` / `with_filter`), so it handles only `settings`.
- Migration: add placement columns to `file_windows`. **Back up the DB first.**

### 5. Desktops

- `desktop.rs`: `read`, `restore_before_show`, `restore_after_show` and `is_on_current`, per platform, all on the main thread (`on_main`).
  - **macOS:** the key is the base64 restorable-state archive. It is replayed before the first show through `AbundioRestorationOptionsUnarchiver` (`_windowRestorationOptions`). The archiver's delegate, `AbundioRestorableStateFilter`, skips the window and its views. There is no way to check the result, so a missing Space is not held.
  - **Windows:** the desktop GUID as 32 hex digits. `MoveWindowToDesktop` runs after the window is shown, then the GUID is read back to check.
  - **X11:** the `_NET_WM_DESKTOP` number. A number at or past `number_of_desktops` counts as gone. On Wayland: `None`.
- The desktop is read only in `record_all`, which runs before every save and on the main thread. `Moved`/`Resized` events keep the desktop already remembered.
- **App start only:** windows restored from `windows.json` (and `main`) restore their desktop. `LaunchRestore` holds their labels, and the *first* `file_windows_restore` from each of them restores its File windows' desktops too. At launch that call is the Active workspace's own reopen. Later reopens open on the current desktop.
- **Never switch desktop:** when restoring a desktop, the window is always shown without being activated, and it is focused only if `is_on_current`.
- **Launch shows all at once:** `place` (hidden) for `main` and every restored window, then `show_launch_windows` steps the app back (`NSApp.deactivate`), shows them all without focus, and `focus_launch_window` focuses the first on the current desktop after 500 ms. Found in testing: wry activates the app for every webview it creates, and AppKit then makes a visible window key, switching Space.
- **Shown in front, not behind:** `orderFront` on macOS, so the window is the one macOS focuses when the user switches to its desktop.
- **Windows/Linux show:** through tao on windows built `.focused(false)` (tao's own no-activate show), never a native `ShowWindow`, which desyncs tao's visible flag. X11's desktop move waits for `map-event`, since window managers ignore requests for unmapped windows.
- **Verified:** the four placement modules compile cleanly for `x86_64-pc-windows-msvc` and `x86_64-unknown-linux-gnu` with a scratch check crate (stubs for the app modules; a fake `pkg-config` for GTK). That caught one Linux compile error. Behaviour on Windows and Linux is untested.
- **Missing desktop:** `PlacementTracker::hold_desktop` keeps the remembered desktop while the window stays on the desktop it landed on. If the window moves to another desktop, that one wins.

### 6. Docs

- ADR-0051 `proposed` → `accepted` (with the prototype result).
- `CLAUDE.md`: a module line for `window_placement.rs` / `desktop.rs`, and a multi-window gotcha: never trust tao's physical positions across monitors.

## Tests

- **Rust unit tests:**
  - `capture` / `resolve`: mixed scales, missing monitor, two monitors with the same name, rearranged displays, a smaller resolution.
  - `from_legacy`.
  - `windows.json` round-trip with and without `placement`.
  - The `file_windows` migration.
- **Manual:**
  - 2× laptop plus 1× external: windows on each monitor survive a restart.
  - Unplug the external: windows go to the laptop and come back when it is plugged in again.
  - Desktops on macOS, plus Windows and X11 if a machine is available.
