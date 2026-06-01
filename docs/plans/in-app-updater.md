# In-app updater for Abundio (Tauri v2 + GitHub Releases)

## Context

Abundio ships releases to GitHub (built cross-platform by `.github/workflows/build.yml` via `tauri-action` on `v*` tags) but has **no update mechanism** — users must notice a new release and reinstall by hand. We want an in-app updater so installed copies learn about and apply new releases themselves.

Abundio is a terminal multiplexer: at any moment a user may have multiple **Profile-bound Windows** open, **Agents** mid-turn, and **shell-mode PTYs** running builds. A Tauri update is disruptive (quit → swap bundle → relaunch kills every PTY and in-flight Agent turn across all Windows). The design below treats that relaunch as a hostile act against the app's core value and defaults to applying updates only when the user naturally quits.

This is a greenfield feature — no existing updater code to migrate.

## Decisions (resolved via grilling)

1. **Install contract:** install-on-quit by **default**; "Install & Restart now" is an explicit, guarded opt-in.
2. **Where it lives:** the version check runs **in Rust** (single source of truth, no per-window races) and emits a Tauri event; the **focused Profile-bound Window** renders the prompt.
3. **Cadence:** auto-check on startup **+ periodic** interval, plus a manual button in Settings, gated by an **"Automatically check for updates" toggle**.
4. **Dismissal:** prompt offers **Install / Later / Skip this version** (Skip persists the version; only a newer release re-prompts).
5. **Publish gate:** workflow keeps creating **draft** releases; clicking **Publish** on GitHub is the deliberate act that ships the update.
6. **Platforms:** macOS + Windows + **Linux-AppImage**; `.deb`/`.rpm` users fall back to manual download.
7. **macOS signing:** ship updater **without** Apple notarization for now; document Gatekeeper friction as a known limitation.
8. **Restart guard:** a **generic, always-accurate confirm** ("Restarting closes all windows and terminates running terminals and agents") — no activity detection.
9. **Progress UX:** inline prompt shows a **determinate progress bar**, then collapses to a persistent "Update ready — will install on quit" indicator; Settings mirrors the same state.

### Verified platform nuance (keystone)
`downloadAndInstall` does **not** auto-relaunch — relaunch is opt-in. On **macOS/Linux-AppImage**, `install()` does not force the app to close (clean deferred install). On **Windows**, the NSIS installer force-closes the app during install, so install-on-quit = **`download()` eagerly, defer `install()` to the quit handler**. The plugin exposes `download()` and `install()` separately for exactly this. Source: https://v2.tauri.app/plugin/updater/

## Signing key — one-time setup (manual, done by maintainer)

```bash
pnpm tauri signer generate -w ~/.tauri/abundio_updater.key   # choose a password
```
- **Public key** (`...key.pub`, base64) → committed in `tauri.conf.json` → `plugins.updater.pubkey`.
- **Private key** → GitHub repo secret `TAURI_SIGNING_PRIVATE_KEY`.
- **Password** → GitHub repo secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **Back up the private key off-machine.** Losing it means existing installs reject all future updates (no recovery path short of a manual-reinstall migration).

## Implementation

### 1. Rust plugin + dependency
- `src-tauri/Cargo.toml`: add `tauri-plugin-updater = "2"` and `tauri-plugin-process = "2"` (for `relaunch`).
- `src-tauri/src/lib.rs` (the `.plugin(...)` chain ~L449): register `.plugin(tauri_plugin_updater::Builder::new().build())` and `.plugin(tauri_plugin_process::init())`.

### 2. Updater config
- `src-tauri/tauri.conf.json`: add
  ```jsonc
  "plugins": {
    "updater": {
      "endpoints": ["https://github.com/<owner>/abundio/releases/latest/download/latest.json"],
      "pubkey": "<public key>",
      "windows": { "installMode": "passive" }
    }
  }
  ```
  Confirm the GitHub `<owner>` from the repo remote during implementation.

### 3. Rust commands + check orchestration (`src-tauri/src/`)
- New `updater.rs` (mirrors existing module style; errors as `AbundioError`):
  - `check_for_update() -> Result<Option<UpdateInfo>, AbundioError>` — wraps `app.updater()?.check()`. `UpdateInfo { version, current_version, body, date }`.
  - `download_update(...)` — calls `update.download(on_chunk, on_done)`; emits progress via a `PtyOutput`-style event (`update-download-progress { downloaded, total }`). Holds the downloaded/`PendingUpdate` in app state (e.g. a `Mutex<Option<Update>>` via `app.manage`) so `install()` can run later.
  - `install_update_now()` — `update.install()` then `tauri_plugin_process` relaunch.
  - Quit-path hook: in the existing `quit-app` MenuItem / `RunEvent` handling (see ADR-0007, `lib.rs`), if an update is staged call `install()` **before** windows tear down. This is the install-on-quit mechanism (and the Windows installer runs here as the app exits).
- Background check loop: spawn a task on setup that runs `check()` shortly after launch and on an interval; on a hit, `emit` an `update-available` event to the **focused window** (resolve via `app.get_focused_window()`/`WebviewWindow`). Respect the auto-check setting (passed from frontend or read from a shared store).
- Register all commands in `commands.rs` / the `invoke_handler` list.

### 4. Capabilities
- `src-tauri/capabilities/default.json` (`windows: ["main","window-*","settings"]`): add `"updater:default"` and `"process:allow-restart"`. Per the multi-window gotcha, ensure these apply to every window label that surfaces the prompt.

### 5. Frontend IPC (`src/lib/ipc.ts`)
- Add an `updates` namespace following the existing namespaced `invoke`/`listen` pattern:
  - `checkForUpdates()`, `downloadUpdate()`, `installUpdateNow()`
  - `onUpdateAvailable(cb)` → `listen("update-available")`
  - `onDownloadProgress(cb)` → `listen("update-download-progress")`
- Route through the demo-mode chokepoint (L37–47) so demo builds get a mock (see §8).

### 6. State + prompt UI
- `src/stores/settingsStore.ts`: add `autoCheckUpdatesEnabled: boolean` (default `true`) and `skippedUpdateVersion: string | null`; include in `partialize`. Cross-window sync already works via the `settings-store-changed` broadcast.
- New `src/stores/updateStore.ts` (or a slice): tracks `status` (`idle | checking | available | downloading | ready | error`), `availableVersion`, `progress`.
- New `src/components/UpdatePrompt.tsx`: a non-blocking prompt (reuse `ConfirmDialog` patterns / Framer Motion styling) mounted in the main app root (`App.tsx`). Buttons: **Install** (→ download, show determinate progress bar, then collapse to a persistent "Update ready — will install on quit" chip), **Later** (dismiss for session), **Skip this version** (write `skippedUpdateVersion`). Honor `skippedUpdateVersion` so skipped versions don't re-prompt.
- Wire the `update-available` listener in `App.tsx` (Profile-bound root). Suppress if `availableVersion === skippedUpdateVersion`.
- "Install & Restart now": secondary action that fires the **generic confirm** (Q8) then `installUpdateNow()`.

### 7. Settings "Updates" section
- `src/components/SettingsPanel.tsx`: add `"updates"` to the `Section` type, a `NavItem` in the left nav, and a content pane showing:
  - **Current version** via `getVersion()` from `@tauri-apps/api/app` (version is currently shown nowhere — this is also the app's first version display).
  - **Check for updates** button + live status (checking / up-to-date / available / downloading-with-progress / ready).
  - **"Automatically check for updates"** toggle bound to `settingsStore`.
  - Mirror of the download/ready state from `updateStore`.

### 8. Demo mode
- `src/lib/demo/`: add mock `checkForUpdates` (returns no-update by default) and stub progress events so `pnpm demo` / `pnpm demo:web` never touch the network or real updater.

### 9. Frontend deps (`package.json`)
- Add `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` (v2). (If we keep all updater calls in Rust commands, the JS plugin packages may be optional — prefer the Rust-command path for the check to honor Decision 2; use JS plugin only if simpler for `download()` progress.)

### 10. CI / release workflow
- `.github/workflows/build.yml`:
  - tauri-action `with:` → add `createUpdaterArtifacts: true` (generates `latest.json` + `.sig` files, merged across the matrix into the one release).
  - `env:` → add `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from secrets.
  - Keep `releaseDraft: true` (Decision 5).
- `scripts/release.sh`: unchanged (it bumps `package.json` / `tauri.conf.json` / `Cargo.toml`; version stays the single source).

## Docs to land during implementation

### ADR `docs/adr/0014-in-app-updater.md`
> **In-app updater via Tauri updater + GitHub Releases, applied on quit.**
> We add `tauri-plugin-updater` pointed at `releases/latest/download/latest.json`, signed with a dedicated Tauri updater key (separate from Apple notarization, which we defer). Because Abundio is a terminal multiplexer where a relaunch kills every live PTY and mid-turn Agent across all Windows, updates **download eagerly but install on the next natural quit** by default (`download()` on accept, `install()` from the `quit-app`/`RunEvent` path — see ADR-0007); an explicit, generically-warned "Install & Restart now" is the only path that interrupts running work. The version **check runs in Rust** and emits to the focused Window so N windows don't each prompt. Releases stay **draft** in CI; clicking *Publish* on GitHub is the deliberate ship action. Considered and rejected: auto-relaunch (destroys the app's core value), auto-publish (no human gate), per-window checks (duplicate prompts).

### CONTEXT.md — Language addition
> **Update**: A newer published Abundio release the running app can fetch and apply via the Tauri updater. App-global (not per-Profile). Lifecycle: *available* → *downloading* → *staged* → *installed on quit*. By default applied only on the next natural quit so live **PTY**s and **Agent** turns survive; an explicit guarded "restart now" is the exception.
> _Avoid_: upgrade, patch, version bump.
> Relationship line: installing an Update on quit ties into the "last-window-closing quits the app" rule — the staged install runs in the quit path before Windows tear down.

## Verification

1. **Rust:** `cd src-tauri && cargo check` and `cargo test`.
2. **Frontend:** `pnpm build` (tsc + vite), `pnpm check`, `pnpm test`.
3. **Updater unit logic:** test skip-version suppression and `update-available` event handling (Vitest, mock `../ipc`); test the Rust `check` mapping into `UpdateInfo` (in-memory, `#[cfg(test)]`).
4. **End-to-end (manual, real):**
   - Generate the key; set the two GitHub secrets.
   - Release a low version locally, then tag/publish a higher `v*` release through CI so a signed `latest.json` is published.
   - Launch the lower-version build; confirm the prompt appears in the focused Window only, progress bar runs, and the "ready — will install on quit" chip shows.
   - Quit normally → relaunch → confirm the new version is running (check Settings → Updates version readout).
   - Re-run with a skipped version → confirm no re-prompt; with auto-check off → confirm only the manual button checks.
   - **Windows** pass: confirm `download()` succeeds and `install()` on quit runs the NSIS installer cleanly.
   - **Demo mode** (`pnpm demo`): confirm no network calls and no updater errors.
