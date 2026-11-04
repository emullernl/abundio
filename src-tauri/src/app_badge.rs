//! The **App icon badge**: the **Attention count** drawn on Abundio's app
//! icon. See `GLOSSARY.md` and `docs/plans/app-icon-badge.md`.
//!
//! Status lives in each Window's frontend, so each Profile-bound Window
//! reports its own share (`report_attention_count`) and this module adds them
//! up, the same shape as the busy tally (ADR-0034).
//!
//! - macOS: `set_badge_count` sets the Dock tile label. One icon for the app.
//! - Linux: `set_badge_count` goes through `libunity`. It shows only on docks
//!   that read the Unity launcher API (Ubuntu Dock, KDE, Plank) and does
//!   nothing elsewhere.
//! - Windows: there is no count API, so we draw a small red circle with the
//!   number and set it as every Window's taskbar overlay icon. All Windows show
//!   the same total, because a grouped taskbar button shows whichever overlay
//!   was set last.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, Window};

use crate::error::AbundioError;

/// Each Profile-bound Window's share of the Attention count, by window label.
#[derive(Default)]
pub struct AttentionCountsState(pub Mutex<HashMap<String, u32>>);

impl AttentionCountsState {
    pub fn set_for_window(&self, window_label: &str, count: u32) {
        self.0
            .lock()
            .unwrap()
            .insert(window_label.to_string(), count);
    }

    /// Drops a destroyed Window's share so it cannot keep the badge up.
    pub fn remove_for_window(&self, window_label: &str) {
        self.0.lock().unwrap().remove(window_label);
    }

    pub fn total(&self) -> u32 {
        self.0.lock().unwrap().values().sum()
    }
}

/// The text the Windows overlay draws: nothing for zero, one digit up to 9,
/// then `9+` (a 16-pixel overlay has no room for more).
pub fn badge_text(total: u32) -> Option<String> {
    match total {
        0 => None,
        1..=9 => Some(total.to_string()),
        _ => Some("9+".to_string()),
    }
}

/// Side of the overlay image in pixels. Windows shows overlays at 16×16 at
/// 100% scaling; 32×32 keeps them sharp on high-DPI screens.
pub const OVERLAY_SIZE: u32 = 32;

const GLYPH_W: usize = 5;
const GLYPH_H: usize = 7;
const GLYPH_SCALE: usize = 2;
const GLYPH_GAP: usize = 1;

/// 5×7 pixel glyphs, one row per byte, the lowest five bits left to right.
fn glyph(c: char) -> Option<[u8; GLYPH_H]> {
    Some(match c {
        '0' => [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
        '1' => [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        '2' => [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
        '3' => [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
        '4' => [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        '5' => [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
        '6' => [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        '7' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        '8' => [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        '9' => [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
        '+' => [0x00, 0x04, 0x04, 0x1F, 0x04, 0x04, 0x00],
        _ => return None,
    })
}

const BADGE_RED: [u8; 3] = [0xE5, 0x39, 0x35];

/// Draws the Windows overlay for `text`: a red anti-aliased circle filling
/// the square, with the text in white, centred. Returns RGBA, row-major,
/// `OVERLAY_SIZE`² pixels. Pure, so it is tested on every platform.
pub fn overlay_rgba(text: &str) -> Vec<u8> {
    let size = OVERLAY_SIZE as usize;
    let mut px = vec![0u8; size * size * 4];

    // Circle: coverage from the distance of each pixel centre to the edge.
    let c = size as f32 / 2.0;
    let r = c - 0.5;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 + 0.5 - c;
            let dy = y as f32 + 0.5 - c;
            let d = (dx * dx + dy * dy).sqrt();
            let alpha = (r - d + 0.5).clamp(0.0, 1.0);
            if alpha > 0.0 {
                let i = (y * size + x) * 4;
                px[i..i + 3].copy_from_slice(&BADGE_RED);
                px[i + 3] = (alpha * 255.0).round() as u8;
            }
        }
    }

    // Text: glyphs scaled up, with a one-pixel (scaled) gap between them.
    let glyphs: Vec<[u8; GLYPH_H]> = text.chars().filter_map(glyph).collect();
    if glyphs.is_empty() {
        return px;
    }
    let cell = GLYPH_W * GLYPH_SCALE;
    let gap = GLYPH_GAP * GLYPH_SCALE;
    let text_w = glyphs.len() * cell + (glyphs.len() - 1) * gap;
    let text_h = GLYPH_H * GLYPH_SCALE;
    let x0 = (size - text_w) / 2;
    let y0 = (size - text_h) / 2;
    for (n, rows) in glyphs.iter().enumerate() {
        let gx = x0 + n * (cell + gap);
        for (row, bits) in rows.iter().enumerate() {
            for col in 0..GLYPH_W {
                if bits & (1 << (GLYPH_W - 1 - col)) == 0 {
                    continue;
                }
                for sy in 0..GLYPH_SCALE {
                    for sx in 0..GLYPH_SCALE {
                        let x = gx + col * GLYPH_SCALE + sx;
                        let y = y0 + row * GLYPH_SCALE + sy;
                        let i = (y * size + x) * 4;
                        px[i..i + 4].copy_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF]);
                    }
                }
            }
        }
    }
    px
}

/// Draws the current total on the app icon. `skip` names a Window that is
/// being destroyed, so it is not the one we ask to set an app-wide badge.
pub fn apply<R: Runtime>(app: &AppHandle<R>, skip: Option<&str>) {
    let total = app
        .try_state::<AttentionCountsState>()
        .map(|s| s.total())
        .unwrap_or(0);

    #[cfg(not(target_os = "windows"))]
    {
        // App-wide on macOS and Linux, so any live window will do.
        let window = app
            .webview_windows()
            .into_iter()
            .find(|(label, _)| Some(label.as_str()) != skip)
            .map(|(_, w)| w);
        if let Some(w) = window {
            let count = if total == 0 { None } else { Some(total as i64) };
            if let Err(e) = w.set_badge_count(count) {
                eprintln!("[abundio] failed to set app icon badge: {e}");
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let icon = badge_text(total)
            .map(|t| tauri::image::Image::new_owned(overlay_rgba(&t), OVERLAY_SIZE, OVERLAY_SIZE));
        for (label, w) in app.webview_windows() {
            if Some(label.as_str()) == skip
                || !crate::window_management::is_profile_window_label(&label)
            {
                continue;
            }
            if let Err(e) = w.set_overlay_icon(icon.clone()) {
                eprintln!("[abundio] failed to set taskbar overlay: {e}");
            }
        }
    }
}

/// A Profile-bound Window reports its share of the Attention count (0 when
/// the badge is turned off). Applies on every report, not only when the total
/// moves, so a newly opened Window on Windows gets its overlay too. The
/// frontend sends only when its own number changes.
#[tauri::command]
pub async fn report_attention_count(
    app: AppHandle,
    window: Window,
    state: tauri::State<'_, AttentionCountsState>,
    count: u32,
) -> Result<(), AbundioError> {
    let label = window.label().to_string();
    if !crate::window_management::is_profile_window_label(&label) {
        return Ok(());
    }
    state.set_for_window(&label, count);
    apply(&app, None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn total_sums_windows_and_forgets_removed_ones() {
        let s = AttentionCountsState::default();
        assert_eq!(s.total(), 0);
        s.set_for_window("main", 2);
        s.set_for_window("window-a", 3);
        assert_eq!(s.total(), 5);
        s.set_for_window("main", 1);
        assert_eq!(s.total(), 4);
        s.remove_for_window("window-a");
        assert_eq!(s.total(), 1);
    }

    #[test]
    fn badge_text_caps_at_nine_plus() {
        assert_eq!(badge_text(0), None);
        assert_eq!(badge_text(1).as_deref(), Some("1"));
        assert_eq!(badge_text(9).as_deref(), Some("9"));
        assert_eq!(badge_text(10).as_deref(), Some("9+"));
        assert_eq!(badge_text(250).as_deref(), Some("9+"));
    }

    fn pixel(px: &[u8], x: usize, y: usize) -> [u8; 4] {
        let i = (y * OVERLAY_SIZE as usize + x) * 4;
        [px[i], px[i + 1], px[i + 2], px[i + 3]]
    }

    #[test]
    fn overlay_is_a_red_circle_with_transparent_corners() {
        let px = overlay_rgba("");
        assert_eq!(px.len(), (OVERLAY_SIZE * OVERLAY_SIZE * 4) as usize);
        let last = OVERLAY_SIZE as usize - 1;
        for (x, y) in [(0, 0), (last, 0), (0, last), (last, last)] {
            assert_eq!(pixel(&px, x, y)[3], 0, "corner {x},{y} must be clear");
        }
        let mid = OVERLAY_SIZE as usize / 2;
        assert_eq!(pixel(&px, mid, mid), [0xE5, 0x39, 0x35, 0xFF]);
    }

    #[test]
    fn overlay_draws_white_text_inside_the_circle() {
        for text in ["1", "7", "9+"] {
            let px = overlay_rgba(text);
            let white = (0..OVERLAY_SIZE as usize)
                .flat_map(|y| (0..OVERLAY_SIZE as usize).map(move |x| (x, y)))
                .filter(|&(x, y)| pixel(&px, x, y) == [0xFF; 4])
                .count();
            assert!(white > 0, "{text} drew no text");
        }
        // Two glyphs draw more than one.
        let count_white = |t: &str| {
            let px = overlay_rgba(t);
            px.chunks(4).filter(|p| p == &[0xFF; 4]).count()
        };
        assert!(count_white("9+") > count_white("9"));
    }

    #[test]
    fn every_badge_text_has_glyphs() {
        for n in 1..=10 {
            let t = badge_text(n).unwrap();
            assert!(t.chars().all(|c| glyph(c).is_some()), "missing glyph in {t}");
        }
    }
}
