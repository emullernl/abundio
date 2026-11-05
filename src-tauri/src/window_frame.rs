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

use crate::window_placement::{self, MonitorInfo, Rect, Remembered, Resolved, WindowPlacement};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Manager, Runtime, WebviewWindow, WindowEvent};
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
pub fn apply<R: Runtime>(window: &WebviewWindow<R>, placement: &WindowPlacement) -> Option<Resolved> {
    let resolved = window_placement::resolve(placement, &monitors(window))?;
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
pub fn track<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(tracker) = window.try_state::<PlacementTracker>() else {
        return;
    };
    tracker.record(window);
    let w = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            if let Some(tracker) = w.try_state::<PlacementTracker>() {
                tracker.record(&w);
            }
        }
    });
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
