//! Multi-window orchestration. See ADR-0007.
//!
//! Each Abundio Window is a Tauri `WebviewWindow` with a stable label of the
//! form `window-<uuid>`. The `ActiveProfileState` map (in `profile_store`) is
//! the source of truth for which Profile each Window is showing.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry};

use crate::error::AbundioError;
use crate::profile_store::{ActiveProfileState, ProfileStore};

/// Window label used for the main (first) window. Stable across restarts so
/// `tauri-plugin-window-state` can save its geometry under a known key.
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Singleton settings window label. The settings window is auxiliary —
/// doesn't claim a profile, isn't persisted in `windows.json`, doesn't count
/// toward "last window closing quits the app". See ADR-0007.
pub const SETTINGS_WINDOW_LABEL: &str = "settings";

/// True for any window that is a profile-bound Abundio window (vs. auxiliary
/// like Settings). Used to filter which windows are counted as "the last
/// window" for the quit-on-empty rule.
pub fn is_profile_window_label(label: &str) -> bool {
    label != SETTINGS_WINDOW_LABEL
}

/// Picks the one Window a single-Window event should go to: the focused
/// Profile-bound Window, else the Profile-bound Window with the lowest label.
/// Never an auxiliary Window — Settings has no listener for these events, so
/// targeting it would silently drop them. Lowest label rather than `HashMap`
/// order, so the fallback is stable (see `owner_of` in lib.rs).
pub fn pick_one_profile_window<'a>(
    windows: impl IntoIterator<Item = (&'a str, bool)>,
) -> Option<String> {
    let mut focused = None;
    let mut lowest: Option<&str> = None;
    for (label, is_focused) in windows {
        if !is_profile_window_label(label) {
            continue;
        }
        if is_focused {
            focused = Some(label);
        }
        if lowest.map_or(true, |l| label < l) {
            lowest = Some(label);
        }
    }
    focused.or(lowest).map(str::to_string)
}

/// Emits `event` to exactly one Profile-bound Window (see
/// `pick_one_profile_window`), never a broadcast. For one-per-app intents and
/// notifications: native-menu Switch Profile, `pr-changes`, `update-available`,
/// `whats-new`. The frontend must hear these through `listenToThisWindow`: a
/// global JS `listen` receives targeted events too, which undoes the targeting.
pub fn emit_to_one_profile_window<S: serde::Serialize + Clone>(
    app: &AppHandle<Wry>,
    event: &str,
    payload: S,
) -> tauri::Result<()> {
    let windows = app.webview_windows();
    let target = pick_one_profile_window(
        windows
            .iter()
            .map(|(label, w)| (label.as_str(), w.is_focused().unwrap_or(false))),
    );
    match target {
        Some(label) => app.emit_to(label.as_str(), event, payload),
        None => Ok(()),
    }
}

/// Generates a fresh window label for spawn-on-demand windows. We deliberately
/// avoid recycling closed-window labels — the tauri-plugin-window-state file
/// is keyed by label and we want each new window to get its own geometry.
pub fn generate_window_label() -> String {
    format!("window-{}", uuid::Uuid::new_v4())
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The clauses naming what is busy, most urgent first, zeroes omitted — e.g.
/// "2 agents working, 1 agent waiting on you and 3 running commands". Empty
/// when nothing is busy, which the caller treats as "no dialog".
pub fn describe_busy(counts: &crate::profile_store::BusyCounts) -> String {
    let mut parts: Vec<String> = Vec::new();
    if counts.working > 0 {
        parts.push(format!("{} working", plural(counts.working, "agent", "agents")));
    }
    if counts.waiting > 0 {
        parts.push(format!(
            "{} waiting on you",
            plural(counts.waiting, "agent", "agents")
        ));
    }
    if counts.commands > 0 {
        parts.push(plural(counts.commands, "running command", "running commands"));
    }
    match parts.len() {
        0 => String::new(),
        1 => parts.remove(0),
        _ => {
            let last = parts.pop().unwrap();
            format!("{} and {last}", parts.join(", "))
        }
    }
}

/// Body text for the quit confirmation, naming what is actually busy rather
/// than how many Workspaces happen to be open — the old wording claimed
/// "running agents and terminal processes" whether or not any existed, so it
/// fired on every quit and was usually untrue. `window_count` lets us drop the
/// awkward "across 1 window" clause when everything is in a single Window. See
/// ADR-0034. Pure so it can be unit-tested without a dialog.
///
/// `None` when nothing is busy: there is no dialog to show, and a quiet
/// Abundio quits silently. Returning an Option rather than a sentence with a
/// hole in it keeps that contract in the type instead of in a doc comment —
/// the caller's `blocks_quit()` guard and this function can no longer disagree
/// about what "nothing busy" renders as.
pub fn quit_confirm_message(
    counts: &crate::profile_store::BusyCounts,
    window_count: usize,
) -> Option<String> {
    let what = describe_busy(counts);
    if what.is_empty() {
        return None;
    }
    Some(if window_count <= 1 {
        format!("You have {what}. Quitting will terminate them. Quit Abundio?")
    } else {
        format!(
            "You have {what} across {window_count} windows. Quitting will terminate them. Quit Abundio?"
        )
    })
}

/// Whether a string is shaped like a settings section id.
///
/// Deliberately a *shape* check, not a list: the canonical set of ids lives in
/// `src/lib/settingsSections.ts` and duplicating it here would give the
/// vocabulary two owners that drift. Lowercase ASCII and `-` covers every id
/// past and present (`theme`, `fonts`, `terminal-font`, …) while excluding the
/// URL metacharacters that make interpolation unsafe.
fn is_section_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
}

/// Opens the singleton settings window, or focuses it if already open. Pass
/// `initial_section` to deep-link to a specific settings section (e.g.
/// "profiles" for the "Manage Profiles…" menu item).
///
/// Both delivery paths are live: when the window already exists the section
/// arrives as a `settings-set-section` event; on a cold open it is encoded in
/// the window URL and read back by `initialSection` in
/// `src/lib/settingsSections.ts`, which also resolves ids from older builds.
///
/// A section id that is not vocabulary-shaped is dropped rather than passed on
/// — see [`is_section_id`].
pub fn open_or_focus_settings_window(
    app: &AppHandle<Wry>,
    initial_section: Option<&str>,
) -> Result<(), AbundioError> {
    use tauri::Emitter;

    // `open_settings_window` is invoke-able with an arbitrary `Option<String>`,
    // so the value is not structurally limited to the internal call sites.
    // Drop anything that isn't shaped like a section id before it reaches the
    // URL, where a `#` would start a fragment and an `&` would inject a param.
    // The JS side rejects unknown ids anyway; this keeps the boundary honest
    // rather than relying on the far side to clean up.
    let initial_section = initial_section.filter(|s| is_section_id(s));

    if let Some(existing) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let _ = existing.set_focus();
        if let Some(section) = initial_section {
            let _ = app.emit_to(
                SETTINGS_WINDOW_LABEL,
                "settings-set-section",
                section.to_string(),
            );
        }
        return Ok(());
    }

    // Put the initial section in the URL so the settings window can read it
    // during its own startup (before any IPC roundtrip would resolve).
    let url_path = match initial_section {
        Some(section) => format!("index.html?settings&section={}", section),
        None => "index.html?settings".to_string(),
    };

    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App(url_path.into()),
    )
    .title("Settings")
    .inner_size(840.0, 620.0)
    .min_inner_size(600.0, 400.0)
    .resizable(true);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    builder
        .build()
        .map_err(|e| AbundioError::InvalidOperation(format!("Settings window build failed: {}", e)))?;
    Ok(())
}

/// Renders a window title for a given profile name. Centralised so the Rust
/// spawn path and the frontend setTitle path use exactly the same format.
pub fn window_title_for(profile_name: &str) -> String {
    format!("Abundio - {} profile", profile_name)
}

/// Opens a new application Window showing the given Profile.
/// Atomically checks the ownership map: if the Profile is already shown in
/// another window, returns an `InvalidOperation` error.
///
/// New windows opened via the menu use `None` for `desired_label` and get a
/// fresh UUID. The `windows.json` restoration path passes `Some(persisted)`
/// so `tauri-plugin-window-state` can match the saved geometry — that plugin
/// keys its per-window-state file by label, so stable labels across launches
/// are what make size and position survive restart.
pub fn open_window_with_profile(
    app: &AppHandle<Wry>,
    profile_id: &str,
) -> Result<String, AbundioError> {
    open_window_with_profile_and_label(app, profile_id, None)
}

pub fn open_window_with_profile_and_label(
    app: &AppHandle<Wry>,
    profile_id: &str,
    desired_label: Option<&str>,
) -> Result<String, AbundioError> {
    let state = app
        .try_state::<ActiveProfileState>()
        .ok_or_else(|| AbundioError::InvalidOperation("ActiveProfileState missing".into()))?;

    // Refuse if the profile doesn't exist (avoids a window that immediately
    // can't load). Also captures the profile name for the window title.
    let profile_store = app
        .try_state::<ProfileStore>()
        .ok_or_else(|| AbundioError::InvalidOperation("ProfileStore missing".into()))?;
    let profile_name = profile_store
        .list()?
        .into_iter()
        .find(|p| p.id == profile_id)
        .map(|p| p.name);
    let Some(profile_name) = profile_name else {
        return Err(AbundioError::NotFound(format!(
            "Profile not found: {}",
            profile_id
        )));
    };

    // Use the requested label if provided and not currently in use; otherwise
    // mint a fresh one. The "in use" check here protects against the case
    // where a restoration tries to claim a label that's already been spawned
    // (e.g. the main window's "main" label).
    let label = match desired_label {
        Some(l) if !app.webview_windows().contains_key(l) => l.to_string(),
        _ => generate_window_label(),
    };

    // Atomically check-and-claim ownership BEFORE the window mounts (the
    // frontend reads it back via get_active_profile_for_window during startup).
    // try_claim folds the "already owned?" check and the insert under one lock
    // so two racing callers can't both build a window for the same profile.
    if let Some(existing_owner) = state.try_claim(&label, profile_id) {
        return Err(AbundioError::InvalidOperation(format!(
            "Profile is already open in window '{}'",
            existing_owner
        )));
    }

    // Match the main window's chrome on macOS: native title bar is overlaid
    // by transparent drag region, traffic lights float on top of content, no
    // OS-drawn title (the React Titlebar component renders it itself). The
    // tauri.macos.conf.json applies these settings to the conf-spawned main
    // window — we replicate them here for every additional window.
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
            .title(&window_title_for(&profile_name))
            .inner_size(1200.0, 800.0)
            .min_inner_size(600.0, 400.0);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    let result = builder.build();

    match result {
        Ok(_window) => {
            // Tell other windows their menus need to refresh ("open elsewhere"
            // dimming for the now-owned profile).
            let _ = app.emit("profile-ownership-changed", ());
            crate::rebuild_menu_for_focused_window(app);
            Ok(label)
        }
        Err(e) => {
            // Roll back the ownership claim on build failure.
            state.remove_for_window(&label);
            Err(AbundioError::InvalidOperation(format!(
                "Window build failed: {}",
                e
            )))
        }
    }
}

/// Creates a new Profile auto-named "Untitled" (or "Untitled N" on collision)
/// and immediately opens it in a new Window.
pub fn create_untitled_profile_in_new_window(
    app: &AppHandle<Wry>,
) -> Result<String, AbundioError> {
    let store = app
        .try_state::<ProfileStore>()
        .ok_or_else(|| AbundioError::InvalidOperation("ProfileStore missing".into()))?;
    let existing = store.list()?;
    let name = next_untitled_name(&existing);

    let profile = store.create(&name)?;
    // Profile create implicitly broadcasts via the command path; here we
    // emit too so other windows see the new entry in their menus.
    let _ = app.emit("profiles-changed", ());

    open_window_with_profile(app, &profile.id)
}

/// Returns the next "Untitled" name not already in use. If no profile starts
/// with "Untitled", returns "Untitled". Otherwise returns "Untitled 2",
/// "Untitled 3", etc., picking the smallest N >= 2 that isn't taken.
pub fn next_untitled_name(existing: &[crate::profile_store::Profile]) -> String {
    let names: std::collections::HashSet<&str> =
        existing.iter().map(|p| p.name.as_str()).collect();
    if !names.contains("Untitled") {
        return "Untitled".to_string();
    }
    let mut n: u32 = 2;
    loop {
        let candidate = format!("Untitled {}", n);
        if !names.contains(candidate.as_str()) {
            return candidate;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile_store::Profile;

    fn p(name: &str) -> Profile {
        Profile {
            id: name.to_string(),
            name: name.to_string(),
            position: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn pick_prefers_the_focused_profile_window() {
        let w = [("main", false), ("window-b", true)];
        assert_eq!(pick_one_profile_window(w).as_deref(), Some("window-b"));
    }

    // Settings focused (the macOS menu bar is shared): it has no listener, so
    // the event must go to a Profile window instead of being dropped.
    #[test]
    fn pick_skips_a_focused_settings_window() {
        let w = [("window-b", false), (SETTINGS_WINDOW_LABEL, true), ("main", false)];
        assert_eq!(pick_one_profile_window(w).as_deref(), Some("main"));
    }

    #[test]
    fn pick_falls_back_to_the_lowest_label() {
        let w = [("window-z", false), ("window-a", false)];
        assert_eq!(pick_one_profile_window(w).as_deref(), Some("window-a"));
    }

    #[test]
    fn pick_none_without_a_profile_window() {
        assert_eq!(pick_one_profile_window([(SETTINGS_WINDOW_LABEL, true)]), None);
    }

    #[test]
    fn untitled_when_none_exist() {
        assert_eq!(next_untitled_name(&[]), "Untitled");
    }

    #[test]
    fn untitled_increments_past_existing() {
        let list = vec![p("Untitled")];
        assert_eq!(next_untitled_name(&list), "Untitled 2");
    }

    #[test]
    fn untitled_picks_smallest_gap() {
        let list = vec![p("Untitled"), p("Untitled 2"), p("Untitled 4")];
        assert_eq!(next_untitled_name(&list), "Untitled 3");
    }

    #[test]
    fn untitled_ignores_unrelated_names() {
        let list = vec![p("Work"), p("Untitled"), p("Personal")];
        assert_eq!(next_untitled_name(&list), "Untitled 2");
    }

    fn counts(working: usize, waiting: usize, commands: usize) -> crate::profile_store::BusyCounts {
        crate::profile_store::BusyCounts {
            working,
            waiting,
            commands,
        }
    }

    #[test]
    fn quit_message_names_what_is_busy() {
        let msg = quit_confirm_message(&counts(1, 0, 0), 1).expect("busy");
        assert!(msg.contains("1 agent working"), "got: {msg}");
        assert!(!msg.contains("across"), "single window omits 'across': {msg}");
        // The old wording claimed agents and processes whether or not any
        // existed — the whole point of ADR-0034 is that it no longer does.
        assert!(!msg.contains("opened workspace"), "got: {msg}");
    }

    #[test]
    fn quit_message_pluralises_and_joins_every_clause() {
        let msg = quit_confirm_message(&counts(2, 1, 3), 1).expect("busy");
        assert!(
            msg.contains("2 agents working, 1 agent waiting on you and 3 running commands"),
            "got: {msg}"
        );
    }

    #[test]
    fn quit_message_multi_window_says_across() {
        let msg = quit_confirm_message(&counts(0, 0, 4), 3).expect("busy");
        assert!(msg.contains("4 running commands"), "got: {msg}");
        assert!(msg.contains("across 3 windows"), "got: {msg}");
    }

    #[test]
    fn quit_message_mentions_only_the_nonzero_clauses() {
        let msg = quit_confirm_message(&counts(0, 1, 0), 1).expect("busy");
        assert!(msg.contains("1 agent waiting on you"), "got: {msg}");
        assert!(!msg.contains("working"), "got: {msg}");
        assert!(!msg.contains("command"), "got: {msg}");
    }

    #[test]
    fn no_quit_message_when_nothing_is_busy() {
        // A quiet Abundio quits silently (ADR-0034). The absence of a message
        // and the caller's `blocks_quit()` guard must agree — so this asserts
        // both, rather than only that the description is empty.
        assert_eq!(describe_busy(&counts(0, 0, 0)), "");
        assert!(quit_confirm_message(&counts(0, 0, 0), 1).is_none());
        assert!(quit_confirm_message(&counts(0, 0, 0), 3).is_none());
        assert!(!counts(0, 0, 0).blocks_quit());
    }

    #[test]
    fn a_message_exists_for_everything_that_blocks_quit() {
        // The guard and the wording cannot drift apart: anything that stops a
        // quit must have something to say about why.
        for c in [
            counts(1, 0, 0),
            counts(0, 1, 0),
            counts(0, 0, 1),
            counts(2, 3, 4),
        ] {
            assert!(c.blocks_quit());
            assert!(quit_confirm_message(&c, 1).is_some());
        }
    }

    #[test]
    fn waiting_alone_blocks_quit_but_is_not_busy_work() {
        // Unload and window close stop only for Busy work; quit also stops for
        // an agent holding a finished turn with a question on it.
        let c = counts(0, 1, 0);
        assert!(!c.has_busy_work());
        assert!(c.blocks_quit());
    }

    #[test]
    fn section_ids_accept_every_shape_the_frontend_uses() {
        for id in [
            "theme",
            "fonts",
            "terminal",
            "editor",
            "agents",
            "prompt-actions",
            "profiles",
            "github",
            "updates",
            // pre-reorg ids an older build's menu could still send
            "terminal-font", "ui-font", "shell",
        ] {
            assert!(is_section_id(id), "rejected {id}");
        }
    }

    #[test]
    fn section_ids_reject_url_metacharacters() {
        // `open_settings_window` is invoke-able with an arbitrary string; a `#`
        // would start a fragment and an `&` would inject a query parameter.
        for bad in [
            "", "pro#files", "profiles&x=1", "profiles?x", "Profiles", "pro files", "a/b", "%2e",
        ] {
            assert!(!is_section_id(bad), "accepted {bad:?}");
        }
        assert!(!is_section_id(&"a".repeat(33)), "accepted an overlong id");
    }
}
