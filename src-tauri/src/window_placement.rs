//! **Window placement** (see GLOSSARY.md, ADR-0051): which monitor a window is
//! on, where on that monitor, how big, and whether it is maximised or
//! fullscreen. Pure: no Tauri, no platform calls, so every rule is testable.
//!
//! # Coordinates
//!
//! Monitors and windows are given in one **desktop space**, the coordinate
//! system the platform glue reads them in. It differs per platform: points on
//! macOS, physical pixels on Windows and X11. Each [`MonitorInfo`] says how
//! many desktop-space units make one logical point on that monitor
//! (`units_per_point`). A placement stores its offset and size in logical
//! points *relative to its monitor*, so it does not depend on the monitor's
//! scale, its resolution, or where it sits in the arrangement.

use serde::{Deserialize, Serialize};

/// A rectangle in desktop space (or in logical points, where noted).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }

    fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px < self.x + self.width && py >= self.y && py < self.y + self.height
    }

    fn overlap_area(&self, o: &Rect) -> f64 {
        let w = (self.x + self.width).min(o.x + o.width) - self.x.max(o.x);
        let h = (self.y + self.height).min(o.y + o.height) - self.y.max(o.y);
        if w > 0.0 && h > 0.0 {
            w * h
        } else {
            0.0
        }
    }

    fn distance_sq_to(&self, px: f64, py: f64) -> f64 {
        let dx = (self.x - px).max(0.0).max(px - (self.x + self.width));
        let dy = (self.y - py).max(0.0).max(py - (self.y + self.height));
        dx * dx + dy * dy
    }
}

/// One connected monitor, as the platform glue reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct MonitorInfo {
    /// The name the OS gives the monitor. Not unique: two monitors of the same
    /// model usually share it.
    pub name: String,
    /// Where the monitor is, in desktop space.
    pub rect: Rect,
    /// Desktop-space units per logical point on this monitor: 1 on macOS
    /// (desktop space is points), the scale factor on Windows and X11.
    pub units_per_point: f64,
    /// The OS scale factor (2 on a Retina screen). Only used to read the old
    /// window-state file, which stored physical pixels.
    pub scale: f64,
    /// The main display: where a window goes when its own monitor is gone.
    pub is_main: bool,
}

/// How a remembered monitor is recognised: by name, and among monitors that
/// share the name, by its place in the arrangement (left to right, then top
/// to bottom).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorKey {
    pub name: String,
    pub arrangement_index: usize,
}

/// A remembered **Window placement**.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPlacement {
    pub monitor: MonitorKey,
    /// Offset of the window's top-left corner from its monitor's top-left
    /// corner, in logical points.
    pub rel_x: f64,
    pub rel_y: f64,
    /// Inner size (what `set_size` takes), in logical points. For a maximised
    /// or fullscreen window, the size it returns to.
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default)]
    pub fullscreen: bool,
    /// The window's desktop, in a platform-specific form (a Windows desktop
    /// GUID, an X11 desktop number, macOS restorable state). `None` where the
    /// platform has none or it could not be read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<String>,
}

/// Where a placement puts a window on the monitors connected now.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    /// Index into the `monitors` slice passed to [`resolve`].
    pub monitor_index: usize,
    /// The window's outer frame, in desktop space.
    pub frame: Rect,
    /// The remembered monitor is not connected, so the window went to the main
    /// display. The placement must then be kept, not overwritten, until the
    /// user moves the window.
    pub fallback: bool,
}

/// Same-name monitors in arrangement order: left to right, then top to bottom.
fn same_name_in_arrangement<'a>(monitors: &'a [MonitorInfo], name: &str) -> Vec<(usize, &'a MonitorInfo)> {
    let mut list: Vec<(usize, &MonitorInfo)> =
        monitors.iter().enumerate().filter(|(_, m)| m.name == name).collect();
    list.sort_by(|(_, a), (_, b)| {
        a.rect
            .x
            .partial_cmp(&b.rect.x)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.rect.y.partial_cmp(&b.rect.y).unwrap_or(std::cmp::Ordering::Equal))
    });
    list
}

fn key_for(monitors: &[MonitorInfo], index: usize) -> MonitorKey {
    let name = &monitors[index].name;
    let arrangement_index = same_name_in_arrangement(monitors, name)
        .iter()
        .position(|(i, _)| *i == index)
        .unwrap_or(0);
    MonitorKey { name: name.clone(), arrangement_index }
}

/// The monitor a window is on: the one holding its centre, else the one it
/// overlaps most, else the nearest one.
pub fn monitor_for(frame: &Rect, monitors: &[MonitorInfo]) -> Option<usize> {
    if monitors.is_empty() {
        return None;
    }
    let (cx, cy) = (frame.x + frame.width / 2.0, frame.y + frame.height / 2.0);
    if let Some(i) = monitors.iter().position(|m| m.rect.contains(cx, cy)) {
        return Some(i);
    }
    let by = |f: &dyn Fn(&MonitorInfo) -> f64, max: bool| {
        monitors
            .iter()
            .enumerate()
            .map(|(i, m)| (i, f(m)))
            .fold(None::<(usize, f64)>, |best, (i, v)| match best {
                Some((_, b)) if (max && v <= b) || (!max && v >= b) => best,
                _ => Some((i, v)),
            })
    };
    match by(&|m| m.rect.overlap_area(frame), true) {
        Some((i, area)) if area > 0.0 => Some(i),
        _ => by(&|m| m.rect.distance_sq_to(cx, cy), false).map(|(i, _)| i),
    }
}

/// Records where a window is now.
///
/// `frame` is the window's outer frame in desktop space. While the window is
/// maximised or fullscreen that frame is the whole monitor, so the size it
/// returns to is kept from `previous` when the window is still on the same
/// monitor.
pub fn capture(
    frame: &Rect,
    maximized: bool,
    fullscreen: bool,
    monitors: &[MonitorInfo],
    previous: Option<&WindowPlacement>,
) -> Option<WindowPlacement> {
    let index = monitor_for(frame, monitors)?;
    let monitor = &monitors[index];
    let key = key_for(monitors, index);
    let desktop = previous.and_then(|p| p.desktop.clone());

    if maximized || fullscreen {
        if let Some(prev) = previous.filter(|p| p.monitor == key) {
            return Some(WindowPlacement { maximized, fullscreen, desktop, ..prev.clone() });
        }
    }

    let u = monitor.units_per_point;
    Some(WindowPlacement {
        monitor: key,
        rel_x: (frame.x - monitor.rect.x) / u,
        rel_y: (frame.y - monitor.rect.y) / u,
        width: frame.width / u,
        height: frame.height / u,
        maximized,
        fullscreen,
        desktop,
    })
}

/// Finds the remembered monitor among those connected now.
fn find_monitor(key: &MonitorKey, monitors: &[MonitorInfo]) -> Option<usize> {
    let same = same_name_in_arrangement(monitors, &key.name);
    // One of two identical monitors unplugged: the one left is "that monitor"
    // whichever place it had.
    same.get(key.arrangement_index.min(same.len().saturating_sub(1))).map(|(i, _)| *i)
}

fn main_monitor(monitors: &[MonitorInfo]) -> Option<usize> {
    if monitors.is_empty() {
        return None;
    }
    Some(monitors.iter().position(|m| m.is_main).unwrap_or(0))
}

/// Where `placement` puts a window on the monitors connected now. `None` only
/// when no monitor is reported at all.
///
/// The window keeps its spot relative to its monitor. If the monitor got
/// smaller, the window is shrunk and pulled in to fit. If the monitor is gone,
/// the same rules place it on the main display, and `fallback` is set.
///
/// A placement's size is the window's inner size, but what has to fit on the
/// monitor is the whole window: `chrome` is how much bigger the outer frame is
/// (title bar and borders, in desktop space; about zero on macOS with an
/// overlay title bar).
pub fn resolve(
    placement: &WindowPlacement,
    monitors: &[MonitorInfo],
    chrome: (f64, f64),
) -> Option<Resolved> {
    let (index, fallback) = match find_monitor(&placement.monitor, monitors) {
        Some(i) => (i, false),
        None => (main_monitor(monitors)?, true),
    };
    let m = &monitors[index];
    let u = m.units_per_point;
    let (cw, ch) = (chrome.0.max(0.0), chrome.1.max(0.0));
    let width = (placement.width * u).min(m.rect.width - cw).max(1.0);
    let height = (placement.height * u).min(m.rect.height - ch).max(1.0);
    // `min` then `max`, never `clamp`: `clamp` panics when the monitor is
    // smaller than the window can shrink to, and this runs during startup.
    let x = (m.rect.x + placement.rel_x * u)
        .min(m.rect.x + m.rect.width - width - cw)
        .max(m.rect.x);
    let y = (m.rect.y + placement.rel_y * u)
        .min(m.rect.y + m.rect.height - height - ch)
        .max(m.rect.y);
    Some(Resolved { monitor_index: index, frame: Rect::new(x, y, width, height), fallback })
}

/// What is remembered for one window: its **home** placement, and where it
/// is while its home monitor is not connected (**away**).
///
/// A window's monitor is kept while that monitor is unplugged, so the window
/// returns to it once it is back. Whatever happens to the window meanwhile
/// (the OS moving it to the laptop screen when the monitor goes, or the user
/// moving it about there) is recorded as `away`, never over `home`. Moving the
/// window while its home monitor *is* connected makes the new spot home.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remembered {
    pub home: WindowPlacement,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away: Option<WindowPlacement>,
}

impl Remembered {
    pub fn new(home: WindowPlacement) -> Self {
        Self { home, away: None }
    }
}

/// Records a new capture `now` against what was remembered.
pub fn remember(previous: Option<&Remembered>, now: WindowPlacement, monitors: &[MonitorInfo]) -> Remembered {
    match previous {
        Some(prev) if find_monitor(&prev.home.monitor, monitors).is_none() => Remembered {
            home: prev.home.clone(),
            away: Some(now),
        },
        _ => Remembered::new(now),
    }
}

/// The placement to restore: home if its monitor is connected, else away if
/// its monitor is, else home (which [`resolve`] then puts on the main display).
pub fn choose<'a>(remembered: &'a Remembered, monitors: &[MonitorInfo]) -> &'a WindowPlacement {
    if find_monitor(&remembered.home.monitor, monitors).is_some() {
        return &remembered.home;
    }
    match &remembered.away {
        Some(away) if find_monitor(&away.monitor, monitors).is_some() => away,
        _ => &remembered.home,
    }
}

/// The part of an old `tauri-plugin-window-state` entry this needs. It stored
/// the window's outer position and inner size in physical pixels, converted
/// with the scale of whichever monitor the window was on at the time.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct LegacyEntry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default)]
    pub fullscreen: bool,
}

/// A best guess at a placement from an old window-state entry, for a window
/// with no placement of its own. The plugin keeps those entries in its file
/// for good but no longer updates them, so once a window has saved a placement
/// this is never used for it again.
///
/// Physical pixels mean nothing without the scale they were taken with, so each
/// monitor is tried in turn: the entry is read with that monitor's scale, and
/// the first monitor that then holds the window's top-left corner wins.
///
/// The same pixels can fit two monitors (2000 px is x=2000 on a 1× external,
/// or x=1000 on a 2× laptop), and the file cannot say which was meant. Other
/// monitors are tried before the main display: when that guess is wrong the
/// window lands on the main display, which is where the old restore put it
/// anyway.
pub fn from_legacy(entry: &LegacyEntry, monitors: &[MonitorInfo]) -> Option<WindowPlacement> {
    if entry.width == 0 || entry.height == 0 {
        return None; // The plugin's "never saved" default.
    }
    let mut order: Vec<(usize, &MonitorInfo)> = monitors.iter().enumerate().collect();
    order.sort_by_key(|(_, m)| m.is_main);
    order.into_iter().find_map(|(i, m)| {
        let to_desktop = m.units_per_point / m.scale;
        let (x, y) = (entry.x as f64 * to_desktop, entry.y as f64 * to_desktop);
        if !m.rect.contains(x, y) {
            return None;
        }
        let u = m.units_per_point;
        Some(WindowPlacement {
            monitor: key_for(monitors, i),
            rel_x: (x - m.rect.x) / u,
            rel_y: (y - m.rect.y) / u,
            width: entry.width as f64 / m.scale,
            height: entry.height as f64 / m.scale,
            maximized: entry.maximized,
            fullscreen: entry.fullscreen,
            desktop: None,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NO_CHROME: (f64, f64) = (0.0, 0.0);

    /// macOS-style desktop space (points): a 2× laptop at the origin and a 1×
    /// external to its right.
    fn laptop() -> MonitorInfo {
        MonitorInfo {
            name: "Built-in Retina Display".into(),
            rect: Rect::new(0.0, 0.0, 1728.0, 1117.0),
            units_per_point: 1.0,
            scale: 2.0,
            is_main: true,
        }
    }
    fn external(name: &str, x: f64) -> MonitorInfo {
        MonitorInfo {
            name: name.into(),
            rect: Rect::new(x, 0.0, 2560.0, 1440.0),
            units_per_point: 1.0,
            scale: 1.0,
            is_main: false,
        }
    }
    fn placement(name: &str, idx: usize, x: f64, y: f64, w: f64, h: f64) -> WindowPlacement {
        WindowPlacement {
            monitor: MonitorKey { name: name.into(), arrangement_index: idx },
            rel_x: x,
            rel_y: y,
            width: w,
            height: h,
            maximized: false,
            fullscreen: false,
            desktop: None,
        }
    }

    #[test]
    fn a_window_on_a_1x_external_comes_back_there_next_to_a_2x_laptop() {
        let mons = [laptop(), external("DELL U2720Q", 1728.0)];
        let p = capture(&Rect::new(2000.0, 100.0, 1200.0, 800.0), false, false, &mons, None).unwrap();
        assert_eq!(p, placement("DELL U2720Q", 0, 272.0, 100.0, 1200.0, 800.0));
        let r = resolve(&p, &mons, NO_CHROME).unwrap();
        assert_eq!(r.monitor_index, 1);
        assert_eq!(r.frame, Rect::new(2000.0, 100.0, 1200.0, 800.0));
        assert!(!r.fallback);
    }

    #[test]
    fn placement_follows_the_monitor_when_the_displays_are_rearranged() {
        let before = [laptop(), external("DELL", 1728.0)];
        let p = capture(&Rect::new(1828.0, 50.0, 800.0, 600.0), false, false, &before, None).unwrap();
        // External moved to the left of the laptop.
        let after = [laptop(), external("DELL", -2560.0)];
        assert_eq!(resolve(&p, &after, NO_CHROME).unwrap().frame, Rect::new(-2460.0, 50.0, 800.0, 600.0));
    }

    #[test]
    fn a_smaller_monitor_shrinks_and_pulls_the_window_in() {
        let p = placement("DELL", 0, 2000.0, 1000.0, 3000.0, 600.0);
        let mons = [laptop(), external("DELL", 1728.0)];
        let r = resolve(&p, &mons, NO_CHROME).unwrap();
        assert_eq!(r.frame, Rect::new(1728.0, 840.0, 2560.0, 600.0));
    }

    #[test]
    fn a_missing_monitor_falls_back_to_the_main_display() {
        let p = placement("DELL", 0, 300.0, 200.0, 2000.0, 900.0);
        let mons = [external("LG", -2560.0), laptop()];
        let r = resolve(&p, &mons, NO_CHROME).unwrap();
        assert_eq!(r.monitor_index, 1);
        assert!(r.fallback);
        // Same relative spot, shrunk to the laptop's width and pulled in.
        assert_eq!(r.frame, Rect::new(0.0, 200.0, 1728.0, 900.0));
    }

    #[test]
    fn a_zero_size_monitor_does_not_panic() {
        let zero = MonitorInfo { rect: Rect::new(0.0, 0.0, 0.0, 0.0), ..laptop() };
        let r = resolve(&placement("Built-in Retina Display", 0, 10.0, 10.0, 800.0, 600.0), &[zero], NO_CHROME)
            .unwrap();
        assert_eq!(r.frame, Rect::new(0.0, 0.0, 1.0, 1.0));
    }

    #[test]
    fn the_title_bar_and_borders_count_when_fitting() {
        // 30 px of title bar and 8 px of borders around the inner size.
        let mons = [laptop()];
        let p = placement("Built-in Retina Display", 0, 100.0, 1000.0, 2000.0, 600.0);
        let r = resolve(&p, &mons, (8.0, 30.0)).unwrap();
        assert_eq!(r.frame.width, 1720.0);
        assert_eq!(r.frame.x + r.frame.width + 8.0, 1728.0);
        assert_eq!(r.frame.y + r.frame.height + 30.0, 1117.0);
    }

    #[test]
    fn no_monitors_resolves_to_nothing() {
        assert_eq!(resolve(&placement("DELL", 0, 0.0, 0.0, 10.0, 10.0), &[], NO_CHROME), None);
        assert_eq!(capture(&Rect::new(0.0, 0.0, 10.0, 10.0), false, false, &[], None), None);
    }

    #[test]
    fn two_identical_monitors_are_told_apart_by_arrangement() {
        // Listed right one first, to show the order comes from position.
        let mons = [laptop(), external("DELL", 4288.0), external("DELL", 1728.0)];
        let right = capture(&Rect::new(4400.0, 10.0, 500.0, 500.0), false, false, &mons, None).unwrap();
        let left = capture(&Rect::new(1800.0, 10.0, 500.0, 500.0), false, false, &mons, None).unwrap();
        assert_eq!(right.monitor.arrangement_index, 1);
        assert_eq!(left.monitor.arrangement_index, 0);
        assert_eq!(resolve(&right, &mons, NO_CHROME).unwrap().monitor_index, 1);
        assert_eq!(resolve(&left, &mons, NO_CHROME).unwrap().monitor_index, 2);
    }

    #[test]
    fn with_one_of_two_identical_monitors_left_the_window_goes_to_it() {
        let p = placement("DELL", 1, 100.0, 100.0, 500.0, 500.0);
        let mons = [laptop(), external("DELL", 1728.0)];
        let r = resolve(&p, &mons, NO_CHROME).unwrap();
        assert_eq!(r.monitor_index, 1);
        assert!(!r.fallback);
    }

    #[test]
    fn physical_pixel_desktop_space_stores_logical_points() {
        // Windows-style: desktop space is physical pixels; a 150% monitor.
        let m = MonitorInfo {
            name: "Generic PnP Monitor".into(),
            rect: Rect::new(1920.0, 0.0, 3840.0, 2160.0),
            units_per_point: 1.5,
            scale: 1.5,
            is_main: false,
        };
        let main = MonitorInfo {
            name: "Main".into(),
            rect: Rect::new(0.0, 0.0, 1920.0, 1080.0),
            units_per_point: 1.0,
            scale: 1.0,
            is_main: true,
        };
        let mons = [main, m];
        let p = capture(&Rect::new(2070.0, 150.0, 1500.0, 900.0), false, false, &mons, None).unwrap();
        assert_eq!((p.rel_x, p.rel_y, p.width, p.height), (100.0, 100.0, 1000.0, 600.0));
        assert_eq!(resolve(&p, &mons, NO_CHROME).unwrap().frame, Rect::new(2070.0, 150.0, 1500.0, 900.0));
    }

    #[test]
    fn a_maximised_window_keeps_the_size_it_returns_to() {
        let mons = [laptop(), external("DELL", 1728.0)];
        let prev = placement("DELL", 0, 100.0, 100.0, 800.0, 600.0);
        let full = Rect::new(1728.0, 0.0, 2560.0, 1440.0);
        let p = capture(&full, true, false, &mons, Some(&prev)).unwrap();
        assert_eq!(p, WindowPlacement { maximized: true, ..prev.clone() });
    }

    #[test]
    fn a_window_maximised_on_another_monitor_takes_that_monitor() {
        let mons = [laptop(), external("DELL", 1728.0)];
        let prev = placement("Built-in Retina Display", 0, 100.0, 100.0, 800.0, 600.0);
        let p = capture(&Rect::new(1728.0, 0.0, 2560.0, 1440.0), true, false, &mons, Some(&prev)).unwrap();
        assert_eq!(p.monitor.name, "DELL");
        assert!(p.maximized);
    }

    #[test]
    fn capture_keeps_the_remembered_desktop() {
        let mons = [laptop()];
        let prev = WindowPlacement { desktop: Some("guid".into()), ..placement("Built-in Retina Display", 0, 0.0, 0.0, 10.0, 10.0) };
        let p = capture(&Rect::new(5.0, 5.0, 100.0, 100.0), false, false, &mons, Some(&prev)).unwrap();
        assert_eq!(p.desktop.as_deref(), Some("guid"));
    }

    #[test]
    fn a_window_straddling_two_monitors_belongs_to_the_one_holding_its_centre() {
        let mons = [laptop(), external("DELL", 1728.0)];
        assert_eq!(monitor_for(&Rect::new(1500.0, 0.0, 600.0, 400.0), &mons), Some(1));
        // Centre off every monitor: the one overlapped most.
        assert_eq!(monitor_for(&Rect::new(1600.0, 1300.0, 400.0, 400.0), &mons), Some(1));
        // Entirely off-screen: the nearest.
        assert_eq!(monitor_for(&Rect::new(-900.0, 0.0, 100.0, 100.0), &mons), Some(0));
    }

    #[test]
    fn legacy_entries_are_read_with_the_scale_of_the_monitor_they_fit() {
        let mons = [laptop(), external("DELL", 1728.0)];
        // Saved on the 1× external: pixels are points.
        let ext = LegacyEntry { x: 2000, y: 100, width: 1200, height: 800, maximized: false, fullscreen: false };
        let p = from_legacy(&ext, &mons).unwrap();
        assert_eq!(p.monitor.name, "DELL");
        // Saved on the 2× laptop: halve. (Pixels that also fit the external
        // would be read as the external's; see `from_legacy`.)
        let lap = LegacyEntry { x: 642, y: 68, width: 3436, height: 2658, maximized: false, fullscreen: false };
        let p = from_legacy(&lap, &mons).unwrap();
        assert_eq!(p, placement("Built-in Retina Display", 0, 321.0, 34.0, 1718.0, 1329.0));
    }

    #[test]
    fn legacy_default_and_off_screen_entries_give_nothing() {
        let mons = [laptop()];
        let empty = LegacyEntry { x: 0, y: 0, width: 0, height: 0, maximized: false, fullscreen: false };
        assert_eq!(from_legacy(&empty, &mons), None);
        let gone = LegacyEntry { x: -5000, y: 0, width: 100, height: 100, maximized: false, fullscreen: false };
        assert_eq!(from_legacy(&gone, &mons), None);
    }

    #[test]
    fn unplugging_the_home_monitor_records_moves_as_away() {
        let home = placement("DELL", 0, 100.0, 100.0, 800.0, 600.0);
        let rem = Remembered::new(home.clone());
        let laptop_only = [laptop()];
        // The OS moves the window to the laptop when the monitor goes.
        let now = placement("Built-in Retina Display", 0, 50.0, 50.0, 800.0, 600.0);
        let rem = remember(Some(&rem), now.clone(), &laptop_only);
        assert_eq!(rem, Remembered { home: home.clone(), away: Some(now.clone()) });
        assert_eq!(choose(&rem, &laptop_only), &now);
        // Plugged back in: home again.
        let both = [laptop(), external("DELL", 1728.0)];
        assert_eq!(choose(&rem, &both), &home);
    }

    #[test]
    fn moving_the_window_while_home_is_connected_makes_a_new_home() {
        let both = [laptop(), external("DELL", 1728.0)];
        let rem = Remembered { home: placement("DELL", 0, 1.0, 1.0, 9.0, 9.0), away: Some(placement("Built-in Retina Display", 0, 2.0, 2.0, 9.0, 9.0)) };
        let now = placement("Built-in Retina Display", 0, 300.0, 300.0, 500.0, 500.0);
        assert_eq!(remember(Some(&rem), now.clone(), &both), Remembered::new(now));
    }

    #[test]
    fn with_neither_home_nor_away_connected_home_is_chosen() {
        let rem = Remembered { home: placement("DELL", 0, 1.0, 1.0, 9.0, 9.0), away: Some(placement("LG", 0, 2.0, 2.0, 9.0, 9.0)) };
        assert_eq!(choose(&rem, &[laptop()]).monitor.name, "DELL");
    }

    #[test]
    fn placement_round_trips_through_json_and_tolerates_missing_fields() {
        let p = WindowPlacement { desktop: Some("3".into()), maximized: true, ..placement("DELL", 1, 1.5, 2.0, 3.0, 4.0) };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"arrangementIndex\":1"));
        assert_eq!(serde_json::from_str::<WindowPlacement>(&json).unwrap(), p);
        let minimal = r#"{"monitor":{"name":"A","arrangementIndex":0},"relX":0,"relY":0,"width":1,"height":1}"#;
        let p: WindowPlacement = serde_json::from_str(minimal).unwrap();
        assert!(!p.maximized && !p.fullscreen && p.desktop.is_none());
    }
}
