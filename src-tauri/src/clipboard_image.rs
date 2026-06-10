//! Places a dropped image file onto the OS clipboard as PNG, so a running agent
//! (Claude Code, Gemini CLI) ingests it via its `Ctrl+V` clipboard-image path.
//!
//! This backs the "Smart image drop" behaviour — see `docs/plans/terminal-file-drop.md`
//! and the `Smart image drop` term in `CONTEXT.md`. The frontend decides *when*
//! to call this (single image dropped onto an agent-mode pane, setting on); this
//! module only does the decode → PNG → clipboard write.
//!
//! macOS is special-cased: Claude Code reads the pasteboard via
//! `osascript … «class PNGf»`, which wants `public.png`. `arboard` would write
//! TIFF, which that read ignores — so on macOS we re-encode to a temp PNG and let
//! `osascript` set the clipboard as PNG. Windows/Linux use `arboard`.

use crate::error::AbundioError;

/// Decode an image file and place it on the OS clipboard as PNG.
///
/// Runs the CPU-bound decode/encode on a blocking thread so a large image never
/// stalls the async runtime. Errors (unreadable file, unsupported/corrupt image,
/// clipboard failure) surface as `AbundioError` — the frontend falls back to
/// inserting the file path when this rejects.
#[tauri::command]
pub async fn set_clipboard_image_from_path(path: String) -> Result<(), AbundioError> {
    tauri::async_runtime::spawn_blocking(move || set_clipboard_image_blocking(&path))
        .await
        .map_err(|e| AbundioError::Clipboard(format!("task join failed: {e}")))?
}

fn set_clipboard_image_blocking(path: &str) -> Result<(), AbundioError> {
    let img = image::ImageReader::open(path)?
        .with_guessed_format()?
        .decode()
        .map_err(|e| AbundioError::Clipboard(format!("decode failed: {e}")))?;

    #[cfg(target_os = "macos")]
    {
        set_clipboard_png_macos(&img)
    }
    #[cfg(not(target_os = "macos"))]
    {
        set_clipboard_rgba_arboard(&img)
    }
}

/// macOS: re-encode to a temp PNG and set the clipboard via AppleScript so the
/// pasteboard carries `public.png` (the format Claude Code's reader expects).
#[cfg(target_os = "macos")]
fn set_clipboard_png_macos(img: &image::DynamicImage) -> Result<(), AbundioError> {
    use std::io::Cursor;

    let mut png: Vec<u8> = Vec::new();
    img.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| AbundioError::Clipboard(format!("png encode failed: {e}")))?;

    // A UUID filename keeps the path free of quotes/spaces, so embedding it in
    // the AppleScript string literal below is safe without escaping.
    let tmp = std::env::temp_dir().join(format!("abundio-drop-{}.png", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, &png)?;

    let script = format!(
        "set the clipboard to (read (POSIX file \"{}\") as «class PNGf»)",
        tmp.display()
    );
    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .status();

    // Best-effort cleanup on every path — osascript reads the file synchronously.
    let _ = std::fs::remove_file(&tmp);

    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(AbundioError::Clipboard(format!("osascript exited: {s}"))),
        Err(e) => Err(AbundioError::Clipboard(format!(
            "osascript spawn failed: {e}"
        ))),
    }
}

/// Windows/Linux: write raw RGBA via `arboard` (CF_DIB on Windows, the
/// `image/png` target on X11/Wayland).
#[cfg(not(target_os = "macos"))]
fn set_clipboard_rgba_arboard(img: &image::DynamicImage) -> Result<(), AbundioError> {
    let rgba = img.to_rgba8();
    let (width, height) = (rgba.width() as usize, rgba.height() as usize);
    let data = arboard::ImageData {
        width,
        height,
        bytes: std::borrow::Cow::Owned(rgba.into_raw()),
    };
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| AbundioError::Clipboard(format!("clipboard open failed: {e}")))?;
    clipboard
        .set_image(data)
        .map_err(|e| AbundioError::Clipboard(format!("set_image failed: {e}")))?;
    Ok(())
}
