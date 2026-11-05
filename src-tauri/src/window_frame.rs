//! Reads and applies a window's frame for **Window placement** (ADR-0051).
//! The rules live in the pure `window_placement`; this is the platform glue.
//!
//! # Why this avoids tao's physical positions
//!
//! On macOS tao converts a window's position between points and pixels with
//! the scale of the screen the window is on *at that moment* (tao#816), and
//! each monitor's rectangle with *that monitor's own* scale. Physical values
//! from different screens are therefore not in one coordinate system. On
//! macOS this module works in points throughout: a monitor's physical
//! rectangle divided by its own scale, a window's divided by the window's
//! current scale, and positions applied as `LogicalPosition`, which tao passes
//! through untouched. Windows and X11 do keep one physical coordinate system,
//! so there desktop space is physical pixels.

use crate::window_placement::{self, LegacyEntry, MonitorInfo, Rect, Remembered, Resolved, WindowPlacement};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow, WindowEvent, Wry};
#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, LogicalSize};
#[cfg(not(target_os = "macos"))]
use tauri::{PhysicalPosition, PhysicalSize};

/// Desktop space is points on macOS and physical pixels elsewhere: see the
/// module docs.
#[cfg(target_os = "macos")]
fn units_per_point(_scale: f64) -> f64 {
    1.0
}
#[cfg(not(target_os = "macos"))]
fn units_per_point(scale: f64) -> f64 {
    scale
}

/// Converts a physical value taken with `scale` into desktop space.
fn physical_to_desktop(v: f64, scale: f64) -> f64 {
    v * units_per_point(scale) / scale
}

/// The connected monitors, in desktop space. Empty if the platform reports
/// none (Wayland can, before a window is mapped).
pub fn monitors<R: Runtime>(window: &WebviewWindow<R>) -> Vec<MonitorInfo> {
    let Ok(list) = window.available_monitors() else {
        return Vec::new();
    };
    let primary = window.primary_monitor().ok().flatten();
    let primary_origin = primary.as_ref().map(|m| *m.position());
    list.iter()
        // A monitor can report 0×0 while it is being unplugged, or in a
        // headless session; nothing can be placed on it.
        .filter(|m| m.size().width > 0 && m.size().height > 0)
        .map(|m| {
            let s = m.scale_factor();
            let pos = m.position();
            let size = m.size();
            MonitorInfo {
                name: m.name().cloned().unwrap_or_default(),
                rect: Rect::new(
                    physical_to_desktop(pos.x as f64, s),
                    physical_to_desktop(pos.y as f64, s),
                    physical_to_desktop(size.width as f64, s),
                    physical_to_desktop(size.height as f64, s),
                ),
                units_per_point: units_per_point(s),
                scale: s,
                is_main: primary_origin == Some(*pos),
            }
        })
        .collect()
}

/// The window's frame in desktop space: outer position, inner size (the size
/// `set_size` takes, so a placement round-trips exactly).
pub fn read_frame<R: Runtime>(window: &WebviewWindow<R>) -> Option<Rect> {
    let pos = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    let s = window.scale_factor().ok()?;
    Some(Rect::new(
        physical_to_desktop(pos.x as f64, s),
        physical_to_desktop(pos.y as f64, s),
        physical_to_desktop(size.width as f64, s),
        physical_to_desktop(size.height as f64, s),
    ))
}

/// How much bigger the window's outer frame is than its inner size (title bar
/// and borders), in desktop space. About zero on macOS with an overlay title
/// bar; real on Windows and on Linux with server-side decorations.
fn chrome<R: Runtime>(window: &WebviewWindow<R>) -> (f64, f64) {
    let (Ok(outer), Ok(inner), Ok(s)) = (window.outer_size(), window.inner_size(), window.scale_factor())
    else {
        return (0.0, 0.0);
    };
    (
        physical_to_desktop(outer.width.saturating_sub(inner.width) as f64, s),
        physical_to_desktop(outer.height.saturating_sub(inner.height) as f64, s),
    )
}

/// Records where the window is now, keeping what `previous` knew that the
/// window itself cannot say (the size it returns to from maximised, the
/// desktop). `None` while minimised: a minimised window's frame is not where
/// it will come back (on Windows it is parked far off-screen).
pub fn capture<R: Runtime>(
    window: &WebviewWindow<R>,
    previous: Option<&WindowPlacement>,
    monitors: &[MonitorInfo],
) -> Option<WindowPlacement> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
    let frame = read_frame(window)?;
    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    window_placement::capture(&frame, maximized, fullscreen, monitors, previous)
}

/// Puts the window where `placement` says, then maximises or makes it
/// fullscreen if it was. Call it while the window is still hidden. Returns
/// where it went, or `None` when no monitor is reported (the window is then
/// left where the OS put it).
pub fn apply<R: Runtime>(
    window: &WebviewWindow<R>,
    placement: &WindowPlacement,
    monitors: &[MonitorInfo],
) -> Option<Resolved> {
    let resolved = window_placement::resolve(placement, monitors, chrome(window))?;
    let f = resolved.frame;
    // Position first, then size: on Windows a move onto a monitor with another
    // DPI rescales the window, so a size set before the move would be undone.
    #[cfg(target_os = "macos")]
    {
        let _ = window.set_position(LogicalPosition::new(f.x, f.y));
        let _ = window.set_size(LogicalSize::new(f.width, f.height));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_position(PhysicalPosition::new(f.x.round() as i32, f.y.round() as i32));
        let _ = window.set_size(PhysicalSize::new(f.width.round() as u32, f.height.round() as u32));
    }
    if placement.fullscreen {
        let _ = window.set_fullscreen(true);
    } else if placement.maximized {
        let _ = window.maximize();
    }
    Some(resolved)
}

/// The **Window placement** of every tracked window, kept current in memory
/// as the windows move. Written to disk from here (with `windows.json`, and
/// into a File window's row when it is destroyed), because a destroyed window
/// can no longer be asked where it was.
#[derive(Default)]
pub struct PlacementTracker {
    map: Mutex<HashMap<String, Remembered>>,
    /// Desktops that could not be restored (they no longer exist), with the
    /// desktop the window landed on instead. While the window stays there,
    /// the missing desktop is kept, so it is tried again next time.
    held_desktops: Mutex<HashMap<String, HeldDesktop>>,
}

struct HeldDesktop {
    remembered: String,
    landed: Option<String>,
}

impl PlacementTracker {
    pub fn get(&self, label: &str) -> Option<Remembered> {
        self.map.lock().unwrap().get(label).cloned()
    }

    pub fn set(&self, label: &str, remembered: Remembered) {
        self.map.lock().unwrap().insert(label.to_string(), remembered);
    }

    pub fn forget(&self, label: &str) {
        self.map.lock().unwrap().remove(label);
        self.held_desktops.lock().unwrap().remove(label);
    }

    fn hold_desktop(&self, label: &str, remembered: String, landed: Option<String>) {
        self.held_desktops
            .lock()
            .unwrap()
            .insert(label.to_string(), HeldDesktop { remembered, landed });
    }

    /// The desktop to remember, given the one the window is on now.
    fn desktop_to_keep(&self, label: &str, now: Option<String>) -> Option<String> {
        let mut held = self.held_desktops.lock().unwrap();
        match held.get(label) {
            Some(h) if h.landed == now => Some(h.remembered.clone()),
            Some(_) => {
                // Moved to another desktop since: that one is now its desktop.
                held.remove(label);
                now
            }
            None => now,
        }
    }

    /// Captures `window` now and records it against what was remembered.
    /// `desktop` is the desktop just read from the window, when it was read
    /// (that has to happen on the main thread, so only [`record_all`] does).
    pub fn record<R: Runtime>(&self, window: &WebviewWindow<R>, desktop: Option<Option<String>>) {
        let monitors = monitors(window);
        let label = window.label();
        let compare = self.get(label).map(|r| window_placement::choose(&r, &monitors).clone());
        let now = capture(window, compare.as_ref(), &monitors);
        self.record_capture(label, now, desktop, &monitors);
    }

    /// The pure half of [`record`](Self::record): records a capture (`None`
    /// while the window is minimised, which changes nothing) against what was
    /// remembered, with the home/away and held-desktop rules.
    fn record_capture(
        &self,
        label: &str,
        now: Option<WindowPlacement>,
        desktop: Option<Option<String>>,
        monitors: &[MonitorInfo],
    ) {
        let Some(mut now) = now else { return };
        if let Some(d) = desktop {
            now.desktop = self.desktop_to_keep(label, d);
        }
        let previous = self.get(label);
        let next = window_placement::remember(previous.as_ref(), now, monitors);
        self.set(label, next);
    }
}

/// Starts keeping `window`'s placement current. Call it once the window has
/// been placed, so the default spot it was built at is never recorded.
///
/// Nothing is recorded right away: on macOS the move `apply` asked for may
/// not have happened yet, and recording the old frame would overwrite the
/// remembered one. The move's own `Moved` event records it, and
/// [`record_all`] catches a window that never moved before it is saved.
pub fn track<R: Runtime>(window: &WebviewWindow<R>) {
    let w = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            if let Some(tracker) = w.try_state::<PlacementTracker>() {
                tracker.record(&w, None);
            }
        }
    });
}

/// Records every open window that has a **Window placement** (Profile-bound
/// and File windows), so what is saved next is where they are now, and writes
/// File windows' placements to their rows. Call it before saving
/// `windows.json` and before destroying windows on their owner's behalf: a
/// destroyed window can no longer be asked.
pub fn record_all(app: &AppHandle<Wry>) {
    let handle = app.clone();
    // On the main thread: reading a window's desktop needs it, and it is cheap
    // enough to do there for the handful of windows an app has.
    crate::desktop::on_main(app, move || {
        let Some(tracker) = handle.try_state::<PlacementTracker>() else {
            return;
        };
        let file_windows = handle.try_state::<crate::file_windows::FileWindowStore>();
        for (label, window) in handle.webview_windows() {
            if !has_placement(&label) {
                continue;
            }
            tracker.record(&window, Some(crate::desktop::read(&window)));
            // A File window's row is written now, not when it is destroyed:
            // on quit the app exits before its `Destroyed` ever runs.
            if let (Some(store), Some(p)) = (&file_windows, tracker.get(&label)) {
                if crate::file_windows::is_file_window_label(&label) {
                    if let Err(e) = store.set_placement(&label, &p) {
                        eprintln!("[abundio] failed to save File window placement: {e}");
                    }
                }
            }
        }
    });
}

/// The windows Abundio places itself; the Settings window is left to
/// `tauri-plugin-window-state`.
pub fn has_placement(label: &str) -> bool {
    crate::window_management::is_profile_window_label(label)
        || crate::file_windows::is_file_window_label(label)
}

/// Entries of the old `tauri-plugin-window-state` file, read at each startup
/// so a window with no placement of its own yet can start from a guess.
#[derive(Default)]
pub struct LegacyPlacements(HashMap<String, LegacyEntry>);

impl LegacyPlacements {
    /// Reads `<app config dir>/.window-state.json`. Missing or unreadable is
    /// an empty set.
    pub fn load(app: &AppHandle<Wry>) -> Self {
        let Ok(dir) = app.path().app_config_dir() else {
            return Self::default();
        };
        let path = dir.join(tauri_plugin_window_state::DEFAULT_FILENAME);
        let map = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, serde_json::Value>>(&s).ok())
            .map(|m| {
                m.into_iter()
                    .filter_map(|(k, v)| Some((k, serde_json::from_value(v).ok()?)))
                    .collect()
            })
            .unwrap_or_default();
        Self(map)
    }

    pub fn get(&self, label: &str) -> Option<&LegacyEntry> {
        self.0.get(label)
    }
}

/// How long the OS gets to settle restored windows onto their desktops
/// before Abundio asks which desktop each is on.
const DESKTOP_SETTLE: std::time::Duration = std::time::Duration::from_millis(500);

/// After app start has restored its windows: focuses the first of `labels`
/// that is on the current desktop, or none. Never one on another desktop,
/// because focusing it would switch the user there (ADR-0051).
///
/// `settle`: wait [`DESKTOP_SETTLE`] first, which only matters when a desktop
/// was restored; otherwise focus goes to the window straight away.
pub fn focus_launch_window(app: &AppHandle<Wry>, labels: Vec<String>, settle: bool) {
    let app = app.clone();
    std::thread::spawn(move || {
        if settle {
            std::thread::sleep(DESKTOP_SETTLE);
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let target = labels.iter().find_map(|l| {
                let w = handle.get_webview_window(l)?;
                (w.is_visible().unwrap_or(false) && crate::desktop::is_on_current(&w)).then_some(w)
            });
            if cfg!(debug_assertions) {
                eprintln!(
                    "[abundio] launch focus: {}",
                    target.as_ref().map(|w| w.label()).unwrap_or("none on this desktop")
                );
            }
            if let Some(w) = target {
                let _ = w.set_focus();
            }
        });
    });
}

/// Profile-bound windows restored at app start whose first File-window
/// reopen has not happened yet. That first reopen (its Active workspace's
/// File windows) is part of app start, so those windows get their desktop
/// back; any later one is the user opening a Workspace, and opens on the
/// current desktop.
#[derive(Default)]
pub struct LaunchRestore {
    first_reopen: Mutex<std::collections::HashSet<String>>,
    /// Restored windows built and placed but not shown yet, with the desktop
    /// [`place`] returned for each. Shown by [`show_launch_windows`].
    pending: Mutex<Vec<(String, Option<String>)>>,
}

impl LaunchRestore {
    pub fn add(&self, label: &str) {
        self.first_reopen.lock().unwrap().insert(label.to_string());
    }

    /// `true` once for each window added: its first reopen.
    pub fn take(&self, label: &str) -> bool {
        self.first_reopen.lock().unwrap().remove(label)
    }

    /// Holds a placed window back until [`show_launch_windows`].
    pub fn defer_show(&self, label: &str, desktop: Option<String>) {
        self.pending.lock().unwrap().push((label.to_string(), desktop));
    }
}

/// Places a freshly built, still hidden window where it was remembered (or,
/// failing that, where the old window-state file had it). With
/// `restore_desktop` it also puts it on its remembered desktop where that has
/// to happen before the window shows (macOS), and returns the desktop for
/// [`show_placed`]. The window stays hidden.
pub fn place(
    window: &WebviewWindow<Wry>,
    remembered: Option<Remembered>,
    restore_desktop: bool,
) -> Option<String> {
    let app = window.app_handle();
    let monitors = monitors(window);
    let remembered = remembered.or_else(|| {
        let legacy = app.try_state::<LegacyPlacements>()?;
        window_placement::from_legacy(legacy.get(window.label())?, &monitors).map(Remembered::new)
    });
    let desktop = remembered
        .as_ref()
        .filter(|_| restore_desktop)
        .and_then(|r| window_placement::choose(r, &monitors).desktop.clone());

    // Restorable state carries a frame too, so it goes first and the
    // placement's own frame wins.
    if let Some(key) = desktop.clone() {
        let w = window.clone();
        crate::desktop::on_main(app, move || crate::desktop::restore_before_show(&w, &key));
    }
    if let Some(r) = &remembered {
        apply(window, window_placement::choose(r, &monitors), &monitors);
        if let Some(tracker) = app.try_state::<PlacementTracker>() {
            tracker.set(window.label(), r.clone());
        }
    }
    desktop
}

/// Shows a window [`place`] placed, and starts tracking it. `desktop` is what
/// `place` returned: the window then always shows without focus, and is moved
/// to that desktop where that happens after showing (Windows, X11).
/// Otherwise `focus: false` shows it without taking keyboard focus.
pub fn show_placed(window: &WebviewWindow<Wry>, desktop: Option<String>, focus: bool) {
    let app = window.app_handle();
    let w = window.clone();
    let handle = app.clone();
    let shown = crate::desktop::on_main(app, move || {
        if desktop.is_none() && focus {
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        crate::window_raise::show_without_focus(&w);
        if let Some(key) = desktop {
            if !crate::desktop::restore_after_show(&w, &key) {
                if let Some(tracker) = handle.try_state::<PlacementTracker>() {
                    tracker.hold_desktop(w.label(), key, crate::desktop::read(&w));
                }
            }
        }
    });
    if shown.is_none() {
        // The main thread did not answer: never leave a window hidden.
        let _ = window.show();
    }
    track(window);
}

/// [`place`] then [`show_placed`], for a window that shows straight away.
pub fn place_and_show(
    window: &WebviewWindow<Wry>,
    remembered: Option<Remembered>,
    focus: bool,
    restore_desktop: bool,
) {
    let desktop = place(window, remembered, restore_desktop);
    show_placed(window, desktop, focus);
}

/// Shows every Profile-bound window restored at app start, once all of them
/// are built and placed, then focuses one on the current desktop (or none).
///
/// Why all at once, at the end: Tauri's webview layer activates the app each
/// time it creates a webview, and an active app that has a visible window
/// but no key window gets that window made key by AppKit, which switches the
/// user to its desktop. So no restored window is visible while webviews are
/// still being created, and the app steps back before they show.
pub fn show_launch_windows(app: &AppHandle<Wry>) {
    let Some(launch) = app.try_state::<LaunchRestore>() else {
        return;
    };
    let pending = std::mem::take(&mut *launch.pending.lock().unwrap());
    let labels: Vec<String> = pending.iter().map(|(l, _)| l.clone()).collect();
    let settle = pending.iter().any(|(_, desktop)| desktop.is_some());
    let handle = app.clone();
    crate::desktop::on_main(app, move || {
        crate::desktop::step_back();
        for (label, desktop) in pending {
            if let Some(w) = handle.get_webview_window(&label) {
                show_placed(&w, desktop, false);
            }
        }
    });
    focus_launch_window(app, labels, settle);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_desktop_space_is_points_whatever_the_scale() {
        assert_eq!(physical_to_desktop(4000.0, 2.0), 2000.0);
        assert_eq!(physical_to_desktop(2000.0, 1.0), 2000.0);
        assert_eq!(units_per_point(2.0), 1.0);
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn elsewhere_desktop_space_is_physical_pixels() {
        assert_eq!(physical_to_desktop(4000.0, 2.0), 4000.0);
        assert_eq!(units_per_point(1.5), 1.5);
    }

    #[test]
    fn launch_restore_is_taken_once_per_window() {
        let l = LaunchRestore::default();
        l.add("main");
        assert!(l.take("main"));
        assert!(!l.take("main"));
        assert!(!l.take("window-new"));
    }

    #[test]
    fn a_missing_desktop_is_kept_while_the_window_stays_where_it_landed() {
        let t = PlacementTracker::default();
        t.hold_desktop("w", "gone".into(), Some("current".into()));
        assert_eq!(t.desktop_to_keep("w", Some("current".into())).as_deref(), Some("gone"));
        assert_eq!(t.desktop_to_keep("w", Some("current".into())).as_deref(), Some("gone"));
        // Moved to another desktop: that one wins, and the hold is dropped.
        assert_eq!(t.desktop_to_keep("w", Some("other".into())).as_deref(), Some("other"));
        assert_eq!(t.desktop_to_keep("w", Some("current".into())).as_deref(), Some("current"));
    }

    #[test]
    fn without_a_hold_the_current_desktop_is_kept() {
        let t = PlacementTracker::default();
        assert_eq!(t.desktop_to_keep("w", Some("d".into())).as_deref(), Some("d"));
        assert_eq!(t.desktop_to_keep("w", None), None);
    }

    fn screen(name: &str, x: f64) -> MonitorInfo {
        MonitorInfo {
            name: name.into(),
            rect: Rect::new(x, 0.0, 1000.0, 800.0),
            units_per_point: 1.0,
            scale: 1.0,
            is_main: x == 0.0,
        }
    }

    fn at(name: &str, x: f64) -> WindowPlacement {
        WindowPlacement {
            monitor: window_placement::MonitorKey { name: name.into(), arrangement_index: 0 },
            rel_x: x,
            rel_y: 0.0,
            width: 100.0,
            height: 100.0,
            maximized: false,
            fullscreen: false,
            desktop: None,
        }
    }

    #[test]
    fn an_unplugged_monitor_keeps_home_and_its_held_desktop_until_it_returns() {
        let t = PlacementTracker::default();
        let both = [screen("Laptop", 0.0), screen("DELL", 1000.0)];
        let laptop_only = [screen("Laptop", 0.0)];

        t.record_capture("w", Some(at("DELL", 10.0)), Some(Some("d2".into())), &both);
        assert_eq!(t.get("w").unwrap().home.desktop.as_deref(), Some("d2"));

        // Launched without the DELL, and desktop d2 is gone: the window lands
        // on the laptop, desktop d1.
        t.hold_desktop("w", "d2".into(), Some("d1".into()));
        t.record_capture("w", Some(at("Laptop", 50.0)), Some(Some("d1".into())), &laptop_only);
        let r = t.get("w").unwrap();
        assert_eq!(r.home.monitor.name, "DELL", "home survives the unplug");
        let away = r.away.as_ref().unwrap();
        assert_eq!((away.monitor.name.as_str(), away.desktop.as_deref()), ("Laptop", Some("d2")));

        // A minimised capture changes nothing.
        t.record_capture("w", None, None, &laptop_only);
        assert_eq!(t.get("w").unwrap(), r);

        // The DELL is back: home is what gets restored.
        assert_eq!(window_placement::choose(&r, &both).monitor.name, "DELL");
    }

    #[test]
    fn forget_drops_the_window_and_its_held_desktop() {
        let t = PlacementTracker::default();
        t.record_capture("w", Some(at("Laptop", 0.0)), None, &[screen("Laptop", 0.0)]);
        t.hold_desktop("w", "gone".into(), None);
        t.forget("w");
        assert!(t.get("w").is_none());
        assert_eq!(t.desktop_to_keep("w", Some("now".into())).as_deref(), Some("now"));
    }
}
