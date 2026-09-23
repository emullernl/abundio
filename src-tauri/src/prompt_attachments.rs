//! Files carried by a **Prompt action**'s **Attachment** parameter.
//!
//! See ADR-0038. The short version: an attachment reaches the Agent as a **file
//! path interpolated into the prompt**, never as a clipboard write plus a
//! synthesised `Ctrl+V`. That keeps the whole action to one bracketed paste and
//! one `\r`, allows more than one file, allows non-image files, and leaves the
//! user's clipboard alone.
//!
//! A file chosen from the picker already has a path and never comes here. Only
//! a **pasted bitmap** does, because a clipboard image has no path, so
//! Abundio has to materialise it.
//!
//! ## Lifetime
//!
//! Nothing owns these files. The Agent may open one immediately, in ten
//! minutes, or never, and may quote the path into its own transcript long
//! after. So the directory is treated as a **cache, not as user data**:
//! content-hashed names make re-pasting the same image free, and a sweep at
//! startup drops anything older than [`MAX_AGE`]. An attachment still being
//! read days later is a case we accept losing rather than one we try to track.
//!
//! It lives under the **versioned** root because it is epoch state an older
//! build has no business reading (ADR-0025).

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

use crate::app_paths;
use crate::error::AbundioError;

/// How long a pasted attachment survives. Deliberately far past any live
/// **Turn** — this is about reclaiming space, not about tracking use.
const MAX_AGE: Duration = Duration::from_secs(60 * 60 * 24 * 14);

/// Refused above this size. An agent prompt is not a file-transfer channel, and
/// a runaway paste should fail loudly rather than fill the disk.
const MAX_BYTES: usize = 25 * 1024 * 1024;

pub fn attachments_dir() -> PathBuf {
    app_paths::versioned_root().join("prompt-attachments")
}

/// Extensions we will write. Anything else is refused rather than guessed at —
/// the name ends up inside a prompt, and a wrong extension makes an Agent
/// misread the file.
fn sanitize_extension(ext: &str) -> Option<String> {
    let lower = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if lower.is_empty() || lower.len() > 8 {
        return None;
    }
    if !lower.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(lower)
}

/// Write bytes to a content-hashed file and return its path.
///
/// Idempotent: the same bytes with the same extension always yield the same
/// path, and an existing file is left alone rather than rewritten. Re-pasting
/// the same screenshot into a second action therefore costs nothing.
pub fn save(bytes: &[u8], extension: &str) -> Result<String, AbundioError> {
    if bytes.is_empty() {
        return Err(AbundioError::InvalidOperation(
            "Nothing to attach — the paste was empty".into(),
        ));
    }
    if bytes.len() > MAX_BYTES {
        return Err(AbundioError::InvalidOperation(format!(
            "Attachment is larger than {} MB",
            MAX_BYTES / (1024 * 1024)
        )));
    }
    let ext = sanitize_extension(extension).ok_or_else(|| {
        AbundioError::InvalidOperation(format!("Unsupported attachment type: {extension}"))
    })?;

    let dir = attachments_dir();
    fs::create_dir_all(&dir)?;

    let digest = Sha256::digest(bytes);
    // 16 hex chars is 64 bits — far past any accidental collision, and short
    // enough that the path stays readable when it appears inside a prompt.
    let name = format!("{:x}", digest);
    let path = dir.join(format!("{}.{ext}", &name[..16]));

    if !path.exists() {
        fs::write(&path, bytes)?;
    }
    Ok(path.to_string_lossy().to_string())
}

/// Drop attachments older than [`MAX_AGE`].
///
/// Best-effort throughout: a directory that does not exist, a file whose
/// metadata cannot be read, and a delete that fails are all fine. This runs at
/// startup and must never be able to stop the app from opening.
pub fn sweep() {
    let dir = attachments_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return; // never used, or not readable — nothing to do either way
    };
    let now = SystemTime::now();
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        // `modified` is the right clock here: a re-paste of the same bytes does
        // not rewrite the file, so `created` would age out something still in
        // active use. We do not touch mtime on reuse either, so this is still a
        // rough proxy — acceptable for a cache whose loss costs a re-paste.
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue; // clock skew put it in the future; leave it alone
        };
        if age > MAX_AGE && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        log::info!("[prompt-attachments] swept {removed} expired attachment(s)");
    }
}

/// Longest side a pasted image is saved at. The clipboard hands over raw
/// pixels, so a pasted photo is re-encoded as PNG, which is lossless and far
/// larger than the JPEG it came from — a 6000×4000 photo easily passes
/// [`MAX_BYTES`]. 4096 px keeps every screenshot (even 5K) sharp and brings
/// most photos back under the limit; no Agent looks at more detail than that.
///
/// "Most", not all: a detailed photo at 4096 px can still run 22–28 MB as PNG.
/// So [`png_within`] tries once more at half this size rather than hand the
/// user an error they cannot act on — the image exists only on the clipboard,
/// so there is no smaller file for them to pick instead.
const MAX_IMAGE_SIDE: u32 = 4096;

/// Most copied files attached in one go. A select-all copy in Finder/Explorer
/// would otherwise interpolate thousands of paths into one prompt.
const MAX_CLIPBOARD_FILES: usize = 32;

/// Wrap raw RGBA pixels, as the clipboard hands them over, in an image.
fn rgba_image(
    width: usize,
    height: usize,
    rgba: Vec<u8>,
) -> Result<image::RgbaImage, AbundioError> {
    let invalid =
        |why: &str| AbundioError::InvalidOperation(format!("Cannot attach the image: {why}"));
    let w = u32::try_from(width).map_err(|_| invalid("it is too wide"))?;
    let h = u32::try_from(height).map_err(|_| invalid("it is too tall"))?;
    image::RgbaImage::from_raw(w, h, rgba)
        .ok_or_else(|| invalid("its pixel data is the wrong size"))
}

/// Encode `img` as PNG, scaled down first so its longest side is at most
/// `max_side`.
fn encode_png(img: &image::RgbaImage, max_side: u32) -> Result<Vec<u8>, AbundioError> {
    use std::io::Cursor;
    let mut png = Vec::new();
    fit_within(img, max_side)
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| AbundioError::InvalidOperation(format!("PNG encode failed: {e}")))?;
    Ok(png)
}

/// Encode `img` at [`MAX_IMAGE_SIDE`], and once more at half that when the
/// result is over `max_bytes`. The second result is returned whatever its size;
/// [`save`] refuses it if it is still too large.
fn png_within(img: &image::RgbaImage, max_bytes: usize) -> Result<Vec<u8>, AbundioError> {
    let png = encode_png(img, MAX_IMAGE_SIDE)?;
    if png.len() <= max_bytes {
        return Ok(png);
    }
    encode_png(img, MAX_IMAGE_SIDE / 2)
}

/// Scale `img` down, keeping its aspect ratio, so neither side exceeds
/// `max_side`. An image already small enough is copied unchanged.
fn fit_within(img: &image::RgbaImage, max_side: u32) -> image::RgbaImage {
    let (w, h) = img.dimensions();
    let longest = w.max(h);
    if longest <= max_side {
        return img.clone();
    }
    let scale = f64::from(max_side) / f64::from(longest);
    let nw = ((f64::from(w) * scale).round() as u32).max(1);
    let nh = ((f64::from(h) * scale).round() as u32).max(1);
    image::imageops::resize(img, nw, nh, image::imageops::FilterType::Triangle)
}

/// Decide what a clipboard file list attaches. `None` when no files were
/// copied, so the caller goes on to the image.
///
/// Folders are dropped: an Attachment is a file, and an Agent cannot read a
/// directory as one. A clipboard holding *only* folders is an error rather
/// than a fall-through to the image, because Finder puts a copied folder's
/// icon on the clipboard too — falling through would attach that icon.
/// Too many files is refused outright rather than silently cut to a subset.
fn attach_copied_files(files: Vec<PathBuf>) -> Result<Option<Vec<String>>, AbundioError> {
    if files.is_empty() {
        return Ok(None);
    }
    let files: Vec<String> = files
        .into_iter()
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    if files.is_empty() {
        return Err(AbundioError::InvalidOperation(
            "Folders cannot be attached — copy files instead".into(),
        ));
    }
    if files.len() > MAX_CLIPBOARD_FILES {
        return Err(AbundioError::InvalidOperation(format!(
            "{} files are on the clipboard — the limit is {MAX_CLIPBOARD_FILES}",
            files.len()
        )));
    }
    Ok(Some(files))
}

/// What "Paste from clipboard" attaches, as paths. Empty when there is nothing
/// to attach.
///
/// **Copied files come first.** Copying a file in Finder also puts that file's
/// *icon* on the clipboard as a picture, so reading the image first would
/// silently attach a generic icon instead of the file. A copied file already
/// has a path, so it is used as-is, like a picked one (ADR-0038) — and it may
/// be any kind of file, which an Attachment accepts.
///
/// `arboard` reads a file list on every platform (macOS file URLs, Windows
/// `CF_HDROP`, Linux `text/uri-list` over X11 — Wayland goes through XWayland,
/// as the `wayland-data-control` feature is off). An empty result there means
/// no files were copied, not a missing backend.
fn paths_from_clipboard_blocking() -> Result<Vec<String>, AbundioError> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| AbundioError::Clipboard(format!("clipboard open failed: {e}")))?;

    // A read error here is not worth failing over: fall through to the image,
    // whose read reports its own.
    if let Ok(files) = clipboard.get().file_list() {
        if let Some(paths) = attach_copied_files(files)? {
            return Ok(paths);
        }
    }

    let data = match clipboard.get_image() {
        Ok(data) => data,
        // Text or nothing at all: not an error, just nothing to attach. The
        // backends disagree on which of these a text-only clipboard reports.
        Err(arboard::Error::ContentNotAvailable | arboard::Error::ConversionFailure) => {
            return Ok(Vec::new())
        }
        Err(e) => return Err(AbundioError::Clipboard(format!("read failed: {e}"))),
    };
    let img = rgba_image(data.width, data.height, data.bytes.into_owned())?;
    let png = png_within(&img, MAX_BYTES)?;
    Ok(vec![save(&png, "png")?])
}

// ── IPC ──

/// Back the dialog's **Paste from clipboard** button: return the path(s) to interpolate
/// into the prompt for whatever is on the OS clipboard — copied files as they
/// are, or an image saved as a PNG. Empty when there is nothing to attach.
///
/// Read here rather than from a webview `paste` event: WebKit only delivers
/// paste to an editable element, so the dialog's Cmd+V never arrived (and the
/// bytes no longer have to cross IPC as base64). The clipboard hands back
/// decoded pixels whatever the source format, so a pasted image is always PNG.
#[tauri::command]
pub async fn prompt_attachment_from_clipboard() -> Result<Vec<String>, AbundioError> {
    tauri::async_runtime::spawn_blocking(paths_from_clipboard_blocking)
        .await
        .map_err(|e| AbundioError::Clipboard(format!("task join failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_is_sanitized_not_guessed() {
        // The name ends up inside a prompt; a wrong extension makes an Agent
        // misread the file, so anything odd is refused rather than repaired.
        assert_eq!(sanitize_extension("PNG"), Some("png".into()));
        assert_eq!(sanitize_extension(".Jpeg"), Some("jpeg".into()));
        assert_eq!(sanitize_extension("  webp "), Some("webp".into()));
        assert_eq!(sanitize_extension(""), None);
        assert_eq!(sanitize_extension("../../etc/passwd"), None);
        assert_eq!(sanitize_extension("pn g"), None);
        assert_eq!(sanitize_extension("verylongextension"), None);
    }

    #[test]
    fn empty_bytes_are_refused() {
        assert!(save(&[], "png").is_err());
    }

    #[test]
    fn an_unsupported_extension_is_refused() {
        assert!(save(b"data", "../evil").is_err());
    }

    fn png_size(png: &[u8]) -> (u32, u32) {
        image::load_from_memory_with_format(png, image::ImageFormat::Png)
            .unwrap()
            .to_rgba8()
            .dimensions()
    }

    #[test]
    fn rgba_pixels_become_a_decodable_png() {
        let rgba = vec![255, 0, 0, 255, 0, 255, 0, 255]; // 2×1: red, green
        let png = encode_png(&rgba_image(2, 1, rgba).unwrap(), MAX_IMAGE_SIDE).unwrap();
        let back = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .unwrap()
            .to_rgba8();
        assert_eq!(back.dimensions(), (2, 1));
        assert_eq!(back.get_pixel(1, 0).0, [0, 255, 0, 255]);
    }

    #[test]
    fn a_large_image_is_scaled_down_keeping_its_shape() {
        let img = image::RgbaImage::new(6000, 4000);
        assert_eq!(fit_within(&img, 4096).dimensions(), (4096, 2731));
    }

    #[test]
    fn a_small_image_is_left_alone() {
        let img = image::RgbaImage::new(1920, 1080);
        assert_eq!(fit_within(&img, 4096).dimensions(), (1920, 1080));
    }

    #[test]
    fn a_very_thin_image_never_scales_to_zero() {
        let img = image::RgbaImage::new(10000, 1);
        assert_eq!(fit_within(&img, 4096).dimensions(), (4096, 1));
    }

    #[test]
    fn an_oversized_png_is_retried_at_half_the_side() {
        // Noise does not compress, so the first encoding is large; a limit one
        // byte under it forces the retry.
        let mut img = image::RgbaImage::new(5000, 8);
        let mut x: u32 = 1;
        for p in img.pixels_mut() {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            p.0 = x.to_le_bytes();
        }
        let first = encode_png(&img, MAX_IMAGE_SIDE).unwrap();
        assert_eq!(png_size(&first).0, MAX_IMAGE_SIDE);

        let retried = png_within(&img, first.len() - 1).unwrap();
        assert_eq!(png_size(&retried).0, MAX_IMAGE_SIDE / 2);

        let kept = png_within(&img, first.len()).unwrap();
        assert_eq!(png_size(&kept).0, MAX_IMAGE_SIDE);
    }

    #[test]
    fn a_short_pixel_buffer_is_refused() {
        assert!(rgba_image(2, 2, vec![0; 4]).is_err());
    }

    #[test]
    fn no_copied_files_falls_through_to_the_image() {
        assert!(attach_copied_files(Vec::new()).unwrap().is_none());
    }

    #[test]
    fn copied_folders_are_dropped_and_files_kept() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        fs::write(&file, b"x").unwrap();
        let got = attach_copied_files(vec![dir.path().to_path_buf(), file.clone()])
            .unwrap()
            .unwrap();
        assert_eq!(got, vec![file.to_string_lossy().to_string()]);
    }

    #[test]
    fn only_folders_is_an_error_not_a_fall_through() {
        // Finder puts a copied folder's icon on the clipboard too; falling
        // through to the image would attach that icon.
        let dir = tempfile::tempdir().unwrap();
        assert!(attach_copied_files(vec![dir.path().to_path_buf()]).is_err());
    }

    #[test]
    fn too_many_copied_files_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let files: Vec<PathBuf> = (0..=MAX_CLIPBOARD_FILES)
            .map(|i| {
                let p = dir.path().join(format!("{i}.txt"));
                fs::write(&p, b"x").unwrap();
                p
            })
            .collect();
        assert!(attach_copied_files(files[..MAX_CLIPBOARD_FILES].to_vec()).is_ok());
        assert!(attach_copied_files(files).is_err());
    }

    #[test]
    fn sweep_on_a_missing_directory_is_harmless() {
        // Runs at startup and must never be able to stop the app opening.
        sweep();
    }
}
