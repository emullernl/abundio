# Close and quit confirmation: per-window React confirm vs native quit dialog

When a **Profile-bound Window** is closed, or the app is quit, with **Opened workspaces** still live (≥1 — aligned with the existing profile-switch confirm, not the originally-requested ">1"), Abundio confirms first so the user doesn't silently lose a running session (agents and PTY processes). The confirmation is implemented in **two different places with two different UIs**, and that split is deliberate.

- **Window close** is gated in the frontend (`App.tsx` `onCloseRequested`) with the same styled React `ConfirmDialog` used everywhere else, counting *this* Window's `usePtyActivityStore.openedWorkspaceIds.size`. The existing dirty-file `SaveConfirmDialog` takes precedence — the workspace confirm only fires when no file is dirty. This path also covers closing the *last* Window (the React confirm runs before Rust's `Destroyed` → `app.exit(0)`).
- **App quit** is gated in Rust, in the custom `quit-app` menu handler, with a **native OS dialog** (`tauri-plugin-dialog`), counting the sum across all Windows. The cross-window total comes from a new `OpenedCountState: Mutex<HashMap<label, usize>>` (mirroring `ActiveProfileState`); each Window's frontend reports its count via IPC on change, and the `Destroyed` handler removes the entry.

## Why the split

- **`RunEvent::ExitRequested` fires *after* the last Window is already destroyed** when triggered by `[NSApp terminate:]` (dock-icon Quit, OS logout/shutdown). The only quit path where Windows still exist — and a confirm can be shown gracefully — is the custom `quit-app` menu item (Cmd+Q / menu "Quit Abundio"). So quit confirmation is **scoped to `quit-app` only**; dock-Quit and OS shutdown are knowingly not gated.
- A **native dialog** was chosen for the quit path over routing through the frontend (deferred quit + React dialog) for robustness and simplicity: the quit decision stays in Rust where the quit lives, works even if a webview is hung, and needs no deferred-quit handshake. The cost is visual inconsistency with the app's React dialogs.
- Single-window Cmd+Q (native dialog) and single-window red-button close (React dialog) are **intentionally not unified**: `quit-app` saves the *full* `windows.json` snapshot (restore next launch), whereas closing the last Window saves an *empty* snapshot ("start over"). Different restoration semantics → separate paths.

## Consequences

- **Dock-icon Quit and OS shutdown do not prompt** — accepted gap; closing it would require a native `NSApplicationDelegate applicationShouldTerminate` hook.
- The same end state ("quit with N opened workspaces") shows a **native** dialog via Cmd+Q but a **styled React** dialog via the red close button. Justified by the differing `windows.json` semantics above.
- Cmd+Q still does **not** prompt for unsaved files (pre-existing behavior, out of scope here) — only the opened-workspace count is gated on quit.
- The quit-time total is read from `OpenedCountState`, which the frontend pushes via fire-and-forget IPC. If a workspace is opened in the sub-100ms window just before Cmd+Q, that report may not have landed yet and Rust can read a stale lower count (e.g. `0`), quitting without a prompt. The window is narrow and structurally similar to the dock-Quit gap above, so it's accepted rather than gated with a synchronous count fetch.
