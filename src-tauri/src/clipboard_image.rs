//! Places a dropped image file onto the OS clipboard as PNG, so a running agent
//! (Claude Code, Gemini CLI) ingests it via its `Ctrl+V` clipboard-image path.
//!
//! This backs the "Smart image drop" behaviour — see `docs/plans/terminal-file-drop.md`
//! and the `Smart image drop` term in `GLOSSARY.md`. The frontend decides *when*
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
    let mut reader = image::ImageReader::open(path)?.with_guessed_format()?;
    // Bound decode allocation so a multi-GB image or a "decompression bomb"
    // (tiny on disk, huge declared dimensions) can't OOM the app. ~256 MB pixel
    // budget — e.g. an 8000×8000 RGBA image is ~256 MB.
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let img = reader
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
    use std::io::{Cursor, Write};

    let mut png: Vec<u8> = Vec::new();
    img.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| AbundioError::Clipboard(format!("png encode failed: {e}")))?;

    // NamedTempFile creates the file atomically (O_EXCL) with 0600 perms and an
    // unpredictable name, and removes it on drop — closing the "insecure temp
    // file" class (predictable name, symlink-follow, world-readable, leak) that
    // a hand-rolled temp_dir().join(...) + fs::write would invite.
    let mut tmp = tempfile::Builder::new()
        .prefix("abundio-drop-")
        .suffix(".png")
        .tempfile()?;
    tmp.write_all(&png)?;
    tmp.flush()?;

    // Escape the path for the AppleScript double-quoted string literal — `\` then
    // `"`. The temp-dir prefix derives from $TMPDIR (attacker-influenceable in
    // principle), so this closes any AppleScript-injection vector.
    let escaped = tmp
        .path()
        .display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let script =
        format!("set the clipboard to (read (POSIX file \"{escaped}\") as «class PNGf»)");
    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .status();

    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(AbundioError::Clipboard(format!("osascript exited: {s}"))),
        Err(e) => Err(AbundioError::Clipboard(format!(
            "osascript spawn failed: {e}"
        ))),
    }
    // `tmp` drops here, removing the temp file on every exit path.
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

// ── Paste tray: read the clipboard's image (docs/plans/paste-tray.md) ──

/// Longest side of a **Pasted image**'s thumbnail in the **Paste tray**.
const THUMB_SIDE: u32 = 160;
/// Longest side of the larger view shown when a thumbnail is clicked.
const FULL_SIDE: u32 = 1600;

/// A clipboard image for the **Paste tray**: two PNGs, base64, already scaled.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastedImage {
    pub thumb: String,
    pub full: String,
    pub width: u32,
    pub height: u32,
}

/// The one clipboard rule for an image paste: an image, no text, no copied
/// files. Text wins, and Finder/Explorer put a copied file's *icon* on the
/// clipboard as a picture, which must never pass for the image.
fn is_image_paste(has_text: bool, has_files: bool, has_image: bool) -> bool {
    has_image && !has_text && !has_files
}

fn pasted_image(img: &image::RgbaImage) -> Result<PastedImage, AbundioError> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let (width, height) = img.dimensions();
    Ok(PastedImage {
        thumb: b64.encode(crate::prompt_attachments::encode_png(img, THUMB_SIDE)?),
        full: b64.encode(crate::prompt_attachments::encode_png(img, FULL_SIDE)?),
        width,
        height,
    })
}

fn peek_blocking() -> Result<Option<PastedImage>, AbundioError> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| AbundioError::Clipboard(format!("clipboard open failed: {e}")))?;
    let has_text = clipboard
        .get_text()
        .map(|t| !t.is_empty())
        .unwrap_or(false);
    let has_files = clipboard
        .get()
        .file_list()
        .map(|f| !f.is_empty())
        .unwrap_or(false);
    // Checked before the image is read, which is the slow part.
    if !is_image_paste(has_text, has_files, true) {
        return Ok(None);
    }
    let data = match clipboard.get_image() {
        Ok(data) => data,
        Err(arboard::Error::ContentNotAvailable | arboard::Error::ConversionFailure) => {
            return Ok(None)
        }
        Err(e) => return Err(AbundioError::Clipboard(format!("read failed: {e}"))),
    };
    let img = crate::prompt_attachments::rgba_image(
        data.width,
        data.height,
        data.bytes.into_owned(),
    )?;
    pasted_image(&img).map(Some)
}

/// What the **Paste tray** and **Smart image paste** see on the clipboard:
/// its image, when the clipboard holds an image and neither text nor copied
/// files; `None` otherwise. Only reads the clipboard, never writes it.
#[tauri::command]
pub async fn clipboard_image_peek() -> Result<Option<PastedImage>, AbundioError> {
    tauri::async_runtime::spawn_blocking(peek_blocking)
        .await
        .map_err(|e| AbundioError::Clipboard(format!("task join failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_image_alone_is_an_image_paste() {
        assert!(is_image_paste(false, false, true));
        assert!(!is_image_paste(true, false, true), "text wins");
        assert!(!is_image_paste(false, true, true), "a copied file's icon is not the image");
        assert!(!is_image_paste(false, false, false));
    }

    #[test]
    fn a_pasted_image_is_scaled_into_two_decodable_pngs() {
        use base64::Engine;
        let img = image::RgbaImage::from_pixel(3200, 800, image::Rgba([1, 2, 3, 255]));
        let p = pasted_image(&img).unwrap();
        assert_eq!((p.width, p.height), (3200, 800), "the size is the original's");
        let b64 = base64::engine::general_purpose::STANDARD;
        let thumb = image::load_from_memory(&b64.decode(&p.thumb).unwrap()).unwrap();
        let full = image::load_from_memory(&b64.decode(&p.full).unwrap()).unwrap();
        assert_eq!((thumb.width(), thumb.height()), (160, 40));
        assert_eq!((full.width(), full.height()), (1600, 400));
    }
}
