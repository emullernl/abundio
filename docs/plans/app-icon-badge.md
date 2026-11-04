# App icon badge

Show the **Attention count** on Abundio's app icon. See `GLOSSARY.md` for both terms.

## What it shows

- **Attention count** = PTYs in **Waiting**, **Ready** or **Error** (Turn failure and
  Mid-turn failure both count), summed across every Profile-bound **Window**.
- Each PTY counts once. A pane in view still counts.
- Zero hides the badge. Turning the setting off hides it too.

## Platforms

| Platform | Mechanism | Notes |
|----------|-----------|-------|
| macOS | `Window::set_badge_count` → Dock tile label | One Dock icon for the whole app. |
| Linux | `Window::set_badge_count` → `libunity` LauncherEntry | Shows on Ubuntu Dock, KDE Plasma, Plank, Dash-to-Dock. Needs `libunity` installed and `<productName>.desktop` as the desktop file. Silent no-op elsewhere (stock GNOME). |
| Windows | `Window::set_overlay_icon` on every Window | No count API exists. We draw a 32×32 red circle with a white number (`1`–`9`, then `9+`). Every Window shows the same total, because grouped taskbar buttons show whichever overlay was set last. |

## Design

Follows the existing **busy tally** pattern (ADR-0034): status lives in each Window's
frontend, so each Window reports its own number and Rust adds them up.

### Frontend

1. `src/lib/attentionCount.ts` — pure `attentionCount(activities)`: counts entries
   whose state is `waiting`, `ready` or `error`, any detection mode.
2. `settingsStore.appIconBadgeEnabled` (default `true`, persisted, settings v15).
3. `App.tsx` effect: subscribe to `usePtyActivityStore` and `useSettingsStore`; report
   `enabled ? count : 0` via `windowSession.reportAttentionCount`, only when the number
   changes. Turning the setting off in Settings syncs to every Window, so each one then
   reports 0.
4. Settings ▸ Agents: a toggle under **Status Hooks**, "Show attention count on app
   icon", with a note that Linux depends on the desktop.
5. Demo `mockInvoke`: `report_attention_count` returns `undefined`.

### Rust

1. `src-tauri/src/app_badge.rs`:
   - `AttentionCountsState(Mutex<HashMap<label, u32>>)` with `set_for_window`,
     `remove_for_window`, `total`.
   - `badge_text(total) -> Option<String>`: `None` for 0, `"1"`–`"9"`, `"9+"`.
   - `overlay_rgba(text) -> Vec<u8>`: draws the Windows overlay (anti-aliased circle +
     5×7 pixel font scaled 2×). Pure, so it is tested on every platform.
   - `apply(app)`: on macOS/Linux, `set_badge_count` once on any window (it is
     app-wide); on Windows, `set_overlay_icon` on every Profile-bound window.
   - `report_attention_count` command: ignores non-Profile windows, stores, applies.
     Applies on every report (not only when the total changes), so a newly opened
     Windows window gets its overlay.
2. `lib.rs`: manage the state, register the command, and on a Profile window's
   `Destroyed` remove its entry and re-apply.

## Tests

- Vitest: `attentionCount` (each state, both modes, Idle/Working ignored).
- Vitest: settings default + setter.
- Rust: state sums across windows and drops a removed window; `badge_text` edges;
  `overlay_rgba` size, transparent corners, red centre ring, white glyph pixels.

## Out of scope

- Bouncing the Dock or flashing the taskbar (`request_user_attention`).
- Per-window counts on Windows.
