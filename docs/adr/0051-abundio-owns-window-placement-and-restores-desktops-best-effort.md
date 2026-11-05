---
status: accepted
---

# Abundio owns Window placement and restores desktops best effort

Profile-bound windows and File windows used to get their size and position from `tauri-plugin-window-state`. On macOS that puts windows on the wrong monitor when monitors have different scales (say a 1× external next to a 2× Retina screen). The plugin saves positions in physical pixels, meaning real screen pixels, so a 2× screen counts twice as many as its apparent size. tao (the windowing layer under Tauri) converts those pixels using the scale of whatever screen the window is on *at that moment*, which halves or doubles the position (tao#816, unfixed). The plugin also records no monitor and no desktop.

Abundio now saves and restores the **Window placement** of these windows itself:

- **What is saved:** the monitor (by name, then by where it sits in the display arrangement), a position relative to that monitor in logical units (points, which do not depend on scale), the size, and whether the window is maximised or fullscreen.
- **Where it is saved:** a Profile window's placement goes in `windows.json`, and a File window's goes in its `file_windows` row. Both are versioned with the data epoch, and each placement is forgotten when its window is.
- **The plugin** stays only for the Settings window.

The desktop is restored too, but only at app start and only as best effort:

- **Windows:** the public `IVirtualDesktopManager`.
- **X11:** `_NET_WM_DESKTOP`.
- **macOS:** Chrome's technique. Each window's AppKit restorable state is saved with the public `encodeRestorableStateWithCoder:` and replayed with `restoreStateWithCoder:` through a decoder that implements the private `_windowRestorationOptions`. macOS has no public API for this (Chromium's FB22128442). Without that one private method, AppKit puts every window on the current Space after a user quit and relaunch, on purpose.
- **Wayland:** the app is not allowed to choose a window's monitor, position or desktop, so only size and maximised state come back.

## Considered Options

- **Keep the plugin and correct the window afterwards.** Rejected: there is a visible jump at launch, and two systems would disagree about where each window belongs.
- **Private SkyLight/CGS calls** (`CGSAddWindowsToSpaces`, `SLSMoveWindowsToManagedSpace`). Rejected: they are more invasive, and Apple broke them in macOS 12.7, 13.6, 14.5 and 15. Window managers such as yabai now hunt for unexported symbols to keep them working.
- **The `NSWindowRestoresWorkspaceAtLaunch` user default.** Undocumented, and dead since macOS 15.
- **No desktop restore on macOS.** Kept as the fallback if Apple breaks the trick. A prototype on macOS 26.7.1 with SIP on (`prototypes/space-restore/`) confirmed the trick works: without the private method the window opened on the current desktop, and with it on the desktop it was saved on.

## Consequences

- Apple can break the macOS desktop restore in any update, with no error. Read the window's Space back after restoring and treat a mismatch as "opened on the current desktop", never as a failure.
- A restore never switches the user's desktop. Restored windows are shown without being activated, because activating a window on another Space makes macOS jump to it.
- A File window reopened with its Workspace later in a session opens on the current desktop. Its monitor and position are still restored.
- A missing monitor is never overwritten. Each window remembers a **home** placement and, while home's monitor is not connected, an **away** one. Moves while home's monitor is away (including the OS moving the window when the monitor is unplugged mid-session) update away; moves while it is connected replace home. Telling a user's move from the OS's is impossible, which is why this rule does not try. A missing desktop is kept while the window stays on the desktop it landed on, on Windows and X11. macOS cannot report where a restored window landed, so a deleted Space is simply replaced by the current one at the next save.
