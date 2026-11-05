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
    let resolved = window_placement::resolve(placement, monitors)?;
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
    }

    /// Captures `window` now and records it against what was remembered.
    pub fn record<R: Runtime>(&self, window: &WebviewWindow<R>) {
        let monitors = monitors(window);
        let label = window.label();
        let previous = self.get(label);
        let compare = previous.as_ref().map(|r| window_placement::choose(r, &monitors));
        if let Some(now) = capture(window, compare, &monitors) {
            let next = window_placement::remember(previous.as_ref(), now, &monitors);
            self.set(label, next);
        }
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
                tracker.record(&w);
            }
        }
    });
}

/// Records every open window that has a **Window placement** (Profile-bound
/// and File windows), so what is saved next is where they are now. Call it
/// before saving `windows.json` and before destroying windows on their
/// owner's behalf: a destroyed window can no longer be asked.
pub fn record_all(app: &AppHandle<Wry>) {
    let Some(tracker) = app.try_state::<PlacementTracker>() else {
        return;
    };
    for (label, window) in app.webview_windows() {
        if has_placement(&label) {
            tracker.record(&window);
        }
    }
}

/// The windows Abundio places itself; the Settings window is left to
/// `tauri-plugin-window-state`.
pub fn has_placement(label: &str) -> bool {
    crate::window_management::is_profile_window_label(label)
        || crate::file_windows::is_file_window_label(label)
}

/// Entries of the old `tauri-plugin-window-state` file, read once at startup
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

/// Places a freshly built, still hidden window where it was remembered (or,
/// failing that, where the old window-state file had it), shows it, and
/// starts tracking it. `focus: false` shows it behind the app's other windows
/// without taking keyboard focus.
pub fn place_and_show(window: &WebviewWindow<Wry>, remembered: Option<Remembered>, focus: bool) {
    let app = window.app_handle();
    let monitors = monitors(window);
    let remembered = remembered.or_else(|| {
        let legacy = app.try_state::<LegacyPlacements>()?;
        window_placement::from_legacy(legacy.get(window.label())?, &monitors).map(Remembered::new)
    });
    if let Some(r) = &remembered {
        apply(window, window_placement::choose(r, &monitors), &monitors);
        if let Some(tracker) = app.try_state::<PlacementTracker>() {
            tracker.set(window.label(), r.clone());
        }
    }
    if focus {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        crate::window_raise::show_without_focus(app, window.clone());
    }
    track(window);
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
}
