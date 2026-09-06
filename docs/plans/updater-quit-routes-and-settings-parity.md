# Updater: cover every quit route, and let every Window see the staged update

## The report

> "When updating Abundio through the settings window, it doesn't actually replace the main
> executable. When I update through the notification window it works fine."

## What is actually wrong

There is **one** updater. `UpdaterState` lives in Rust and is app-global; the Settings window's
Updates section and the `UpdatePrompt` card are two *views* of it. So "the Settings updater is
broken" was never the shape of the bug. Two separate defects produced that impression.

### Defect 1 — Dock quit never installs the staged update (the real one)

The user quit from the **Dock icon**. Tracing the crates we build against:

- Dock Quit is `[NSApp terminate:]` → tao's `applicationWillTerminate`
  (`tao-0.35.3/src/platform_impl/macos/app_delegate.rs:131`) → `AppState::exit()`, which emits
  **only** `Event::LoopDestroyed`.
- `tauri-runtime-wry-2.11.2/src/lib.rs:4192` maps `LoopDestroyed` → **`RunEvent::Exit`**.
- `RunEvent::ExitRequested` is emitted from exactly one place (`:4323`): the **last tao window's
  `Destroyed` event**. Dock quit destroys no windows first, so it never fires.
- Our run closure (`src-tauri/src/lib.rs:1014`) handles **`ExitRequested` only**.

Therefore on a Dock quit `apply_staged_update_on_quit` is never called and the downloaded bundle
dies with the process. Cmd+Q works (custom `quit-app` menu item → `perform_quit`); "Restart now"
works (`updater_install_now`). Both working paths and the one broken path line up exactly.

The same gap means **`windows.json` is not snapshotted on a Dock quit** either — window
restoration is silently wrong after one.

### Defect 2 — the Settings section is blind and has no install button

`useUpdateStore` is per-JS-context and the Settings window is its own webview, but no window can
ask Rust what the updater's state is. So:

- Download from the card → staged in Rust → open Settings → its store is `idle` → it offers
  "Check for updates", as if nothing had happened.
- Clicking it re-stashes `pending`, and "Install update" then **re-downloads the whole bundle**,
  overwriting a perfectly good staged copy.
- Settings says *"restart Abundio to get the new version"* and offers no way to do it — the card's
  "Restart now" exists nowhere else.

## Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| 1 | Fix the root cause **and** add Settings parity **and** fix the `windows.json` half. | Only adding a "Restart now" button — leaves ADR-0014's contract false for one of three quit routes. |
| 2 | Call the existing install from `RunEvent::Exit`. | A detached helper process that swaps the bundle after our PID dies. Correct long-term shape; a much larger change with its own signing questions. Recorded as a known hazard instead. |
| 3 | Add an `updater_status` command; both views hydrate from it. | Button-only parity — leaves Settings telling a different story from the rest of the app, and keeps the re-download. |
| 4 | The **card** hydrates through skip/snooze suppression; **Settings** hydrates unconditionally. | Card ignoring suppression, which would silently defeat "Skip this version". |
| 5 | `updater_status` reports `none \| available \| ready` only. A `downloading` bool exists solely to give `updater_download` an honest error. | A `downloading` status, which would need `update-staged` / `update-failed` broadcasts or leave a window stuck on a fake progress bar forever. |

### Accepted hazard (decision 2)

On the Dock-quit route the install runs **on the main thread inside `applicationWillTerminate`**,
with AppKit waiting on us:

1. `install_inner` (`tauri-plugin-updater-2.10.1/src/updater.rs:1217`) extracts the whole `.app`
   tarball, then `remove_dir_all`s the live bundle *before* renaming the new one in. A watchdog
   kill in that window leaves **no app installed**.
2. Its `PermissionDenied` fallback blocks on an AppleScript admin prompt dispatched via
   `run_on_main_thread` (`:1281`) — to a main thread that is already winding down. Potential hang
   on quit.

Both already apply to the `quit-app` route we use daily; this change extends them to Dock quit
rather than introducing them. Accepted deliberately, recorded in ADR-0014.

## Changes

### Rust

1. **`lib.rs`** — extract the `RunEvent::ExitRequested` body into `fn on_app_exit(app)` and call it
   from **both** `ExitRequested` and `Exit`. The existing `QuittingFlag` guard makes it idempotent:
   the second call sees the flag set and skips the `windows.json` save, which matters — by then the
   `Destroyed` handlers have emptied `ActiveProfileState`, so re-saving would overwrite the good
   snapshot with an empty one.
2. **`updater.rs`** — add `downloading: bool` to `UpdaterInner`, set/cleared around the download, so
   a concurrent `updater_download` returns *"a download is already in progress"* rather than the
   misleading *"no pending update to download"*.
3. **`updater.rs`** — add `updater_status` → `{ state: "none" | "available" | "ready", info }`,
   reading `staged` then `pending`. Register it in `lib.rs`.

### Frontend

4. **`lib/ipc.ts`** — `UpdaterStatus` type + `updates.status()`.
5. **`stores/updateStore.ts`** — `hydrate({ respectSuppression })`: `ready` → `status: "ready"`,
   `available` → `status: "available"`, `none` → leave alone. Never downgrades a window that is
   mid-download.
6. **`App.tsx`** — hydrate with `respectSuppression: true` on mount.
7. **`Settings/UpdatesSection.tsx`** — hydrate with `respectSuppression: false` on mount; add a
   **Restart now** button for `status === "ready"`, behind the same `ConfirmDialog` the card uses.
8. **`lib/demo/mockInvoke.ts`** — handle `updater_status`.

## Verification

- Rust unit tests: `on_app_exit` idempotence via the flag, the `downloading` guard, and
  `updater_status`'s mapping.
- Frontend tests: `hydrate` suppression behaviour and the Settings Restart-now flow.
- **The `RunEvent::Exit` wiring is not unit-testable** — it needs a live event loop and a real
  `[NSApp terminate:]`. Verified by hand: `pnpm tauri dev`, quit from the Dock, confirm
  `apply_staged_update_on_quit`'s log line appears. In dev the app is not a `.app` bundle so no
  real update can stage; this proves *the handler is reached*, which is the only thing in doubt —
  the install itself is the same code "Restart now" already exercises.
- Full end-to-end (download → Dock quit → relaunch on the new version) happens free on the next
  real release.
