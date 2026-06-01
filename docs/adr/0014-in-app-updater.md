# In-app updater via Tauri updater + GitHub Releases, applied on quit

Abundio shipped releases to GitHub but had no update mechanism, so users had to notice and reinstall by hand. We add `tauri-plugin-updater` pointed at `https://github.com/emullernl/abundio/releases/latest/download/latest.json`, with artifacts signed by a dedicated Tauri updater key (separate from Apple notarization, which we defer — unsigned macOS auto-updates may hit Gatekeeper friction, a known limitation).

Because Abundio is a terminal multiplexer where a relaunch kills every live **PTY** and mid-turn **Agent** across all **Windows**, updates **download eagerly but install on the next natural quit** by default: the frontend calls `updater_download` on accept, and `updater::apply_staged_update_on_quit` runs `Update::install` from the quit paths (the custom `quit-app` menu item and `RunEvent::ExitRequested` — see ADR-0007). On macOS/Linux-AppImage the bundle swaps in place; on Windows the passive NSIS installer runs as the app exits. The only path that interrupts running work is an explicit, generically-warned "Install & Restart now" (`updater_install_now` → `AppHandle::restart`).

The version **check runs in Rust** (`updater.rs`) — a background loop that honours the frontend "Automatically check for updates" flag — and emits `update-available` to the **focused Window** only (via `emit_to_focused`), so N open Windows don't each prompt. Everything goes through app-defined `#[tauri::command]`s rather than the JS updater plugin, so no extra capability permissions were needed.

Releases stay **draft** in CI (`build.yml` keeps `releaseDraft: true`); clicking *Publish* on GitHub is the deliberate act that ships the update to all installs, since `releases/latest` only resolves to a published, non-prerelease release.

## Considered and rejected

- **Auto-relaunch on install** — destroys the app's core value (live terminals/agents) without consent.
- **Auto-publish on tag** — removes the human gate; a bad build would reach everyone the moment CI finishes.
- **Per-Window JS-plugin checks** — duplicate prompts across Windows and unnecessary capability surface.
- **Notify-only (open download page)** — simpler, no signing key, but no in-app install; rejected in favour of the full updater.

## Consequences

- The Tauri updater **private key must be backed up off-machine**: losing it means existing installs reject all future updates (no recovery short of a manual-reinstall migration).
- `bundle.createUpdaterArtifacts` is enabled, so a local `pnpm tauri build` without `TAURI_SIGNING_PRIVATE_KEY` set will fail to sign — bundle builds are a CI/release concern.
