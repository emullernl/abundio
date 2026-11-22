//! The color a new window shows before its page has painted: the user's
//! theme background, so a window never flashes white while it loads. The
//! webview's own storage is per window and out of Rust's reach, so each
//! Window reports its theme's background (`window_background_set`) and the
//! last one is kept in a small file for the next app start.

use std::path::PathBuf;
use tauri::window::Color;

/// The default theme's background (`themes.ts`), before any is reported.
const DEFAULT: Color = Color(0x0D, 0x11, 0x17, 0xFF);

fn path() -> PathBuf {
    crate::app_paths::shared_root().join("window-background")
}

/// `#RRGGBB` as a color.
pub fn parse_hex(s: &str) -> Option<Color> {
    let h = s.trim().strip_prefix('#')?;
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some(Color(byte(0)?, byte(2)?, byte(4)?, 0xFF))
}

/// The background for a window built now.
pub fn current() -> Color {
    std::fs::read_to_string(path()).ok().as_deref().and_then(parse_hex).unwrap_or(DEFAULT)
}

/// A Window applied a theme: its background is the next windows' color.
#[tauri::command]
pub fn window_background_set(color: String) -> Result<(), crate::error::AbundioError> {
    let Some(_) = parse_hex(&color) else {
        return Err(crate::error::AbundioError::InvalidOperation("not a #RRGGBB color".into()));
    };
    let value = color.trim().to_ascii_uppercase();
    if std::fs::read_to_string(path()).ok().as_deref() != Some(value.as_str()) {
        std::fs::write(path(), value)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_a_six_digit_hex_color() {
        assert_eq!(parse_hex("#0d1117"), Some(Color(0x0D, 0x11, 0x17, 0xFF)));
        assert_eq!(parse_hex(" #FFFFFF\n"), Some(Color(0xFF, 0xFF, 0xFF, 0xFF)));
        for bad in ["", "0D1117", "#0D11", "#0D1117FF", "#GG1117", "red"] {
            assert_eq!(parse_hex(bad), None, "{bad}");
        }
    }
}
