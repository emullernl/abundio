# Updater: always offer the newest release

## The question

> "When a new version is detected, how long is it cached in the settings window? What happens
> when in the meantime another new version is released and the app is still running?"

## What is wrong today

A found release is held in Rust (`UpdaterState.pending`) with no expiry. Three things then go
wrong while the app keeps running:

1. **Settings never looks again once something is held.** `checkOnOpen` hydrates, sees
   `available` or `ready`, and returns before checking. Only the background loop (every 6 h,
   auto-check on) or the **Check for updates** button can find a newer release. This contradicts
   the glossary, which says opening the Updates section checks.
2. **A downloaded release hides a newer one in Settings.** `updater_status` reports `staged`
   before `pending`, so Settings keeps showing the older version as ready. Meanwhile the prompt
   card's `setAvailable` overwrites `ready` with the newer `available` one, so the two views
   disagree.
3. **A pulled release is offered until restart.** A check that finds nothing (`Ok(None)`)
   leaves `pending` as it was.

A Settings window left open on Updates also never refreshes. `update-available` goes to one
Profile window only, and `checkOnOpen` runs only when the section opens.

## Decisions

Settled in a grilling session; recorded in `CONTEXT.md` (**Update**) and the ADR-0014 addendum.

1. The **Update** is the newest published release. A newer one replaces a held *available*
   release. A download in progress is left to finish.
2. A *staged* release is kept, and still installs on quit, until a newer one finishes
   downloading. The updater can hold an older *staged* and a newer *available* release at once.
3. Settings shows the newer release as the main row (**Download**) and a smaller line saying the
   older one installs on quit (**Restart now**).
4. Opening the Updates section always checks, even when an Update is held, at most once every
   5 minutes.
5. An open Settings window refreshes itself when Rust's held state changes. Only the Settings
   window listens; Profile windows keep the one-window prompt rule.
6. "Later" still hides the prompt for 24 hours, even when a newer version arrives meanwhile.
7. The prompt card tells the same story as Settings: newer release offered, older one installs
   on quit.
8. A check that finds nothing newer drops a held *available* release. A *staged* one is kept. A
   failed check changes nothing.
9. A check result no newer than the staged release is never held as *available*.

## Implementation (one branch, ordered commits)

### 1. Rust: hold both, report both, drop stale results

`src-tauri/src/updater.rs`

- `UpdaterStatus` reports both slots instead of one `state`:
  `staged: Option<UpdateInfo>` and `available: Option<UpdateInfo>`.
- One shared helper, used by both `check_and_emit` and `updater_check`, applies a check result
  to `UpdaterInner` under the lock:
  - `Some(update)` newer than the staged version → `pending = Some(update)`.
  - `Some(update)` no newer than the staged version → `pending = None` (rule 9).
  - `None` → `pending = None`; `staged` untouched (rule 8).
  - An error never reaches the helper, so it changes nothing.
  - Returns whether the held state changed.
- Compare versions with `semver` (already pulled in by `tauri-plugin-updater`; add it as a
  direct dependency) rather than as strings.
- `updater_check` returns `None` to the frontend when the result was dropped by rule 9, so a
  manual check says "up to date" rather than offering what is already downloaded.
- `check_and_emit` emits `update-available` only when a newer release was stored, as today.

### 2. Rust: tell Settings when the held state changes

- Emit a payload-free `updater-state-changed` event whenever `pending` or `staged` changes:
  after the check helper reports a change, after a download succeeds or fails, and after
  `updater_install_now` fails and puts the staged release back.
- Payload-free, like the Prompt actions change event (ADR-0039): receivers re-read through
  `updater_status`.

### 3. Store: track both releases

`src/stores/updateStore.ts`, `src/lib/ipc.ts`

- Mirror the new `UpdaterStatus` shape in `ipc.ts`.
- Add `staged: UpdateInfo | null` to the store, next to `info` (the release being offered).
- `hydrate` fills both. `status` is `available` when there is an available release, else
  `ready` when there is a staged one, else unchanged.
- `setAvailable` sets the newer `info` and keeps `staged` (rule 7).
- `checkOnOpen`: drop the early return for `available`/`ready`; keep the return for
  `checking`/`downloading` and the 5-minute limit (rule 4). Show the held release while the
  check runs, so the row does not blank to "Checking…".
- `download` success: `staged = info`, `status = "ready"`.

### 4. UI

- `components/Settings/UpdatesSection.tsx`: when both are held, the main row offers `info` with
  **Download**, and a smaller line below reads "v{staged} is downloaded and will install when
  you quit." with **Restart now** (rule 3).
- `components/UpdatePrompt.tsx`: in the `available` state, add the line "v{staged} will install
  on quit." when `staged` is set (rule 7). Snooze and skip are unchanged (rule 6).
- `SettingsApp.tsx`: listen to `updater-state-changed` and call
  `hydrate({ respectSuppression: false })` (rule 5). Not added to `App.tsx`.

### 5. Docs

- Mention the change in the GitHub Release notes when shipping (✨/🐛 style).
- `CONTEXT.md` and the ADR-0014 addendum are already written.

## Tests

Rust (`updater.rs` `#[cfg(test)]`), on the check helper and `UpdaterInner` directly:

- Newer result with nothing staged → held as available.
- Newer result with an older staged release → both held.
- Result equal to or older than the staged release → not held; existing `pending` cleared.
- `None` result → `pending` cleared, `staged` kept.
- Status reports both slots when both are held.

Frontend (`src/stores/__tests__/updateStore.test.ts`):

- `checkOnOpen` checks while an `available` release is held, unless the last check was under
  5 minutes ago.
- `checkOnOpen` still checks while a `ready` release is held.
- `setAvailable` keeps `staged`.
- `hydrate` fills both `info` and `staged`.
- `download` success moves `info` into `staged`.

## Verifying in the real app

Unit tests do not cover the event flow. Before calling this done, run the app against a local
`latest.json` and walk through: find v-next → download → publish v-next+1 → open Settings
(both shown) → leave Settings open and let the background check fire (it refreshes) → quit
during the second download (the first installs).
