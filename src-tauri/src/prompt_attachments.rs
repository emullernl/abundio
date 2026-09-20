//! Files carried by a **Prompt action**'s **Attachment** parameter.
//!
//! See ADR-0038. The short version: an attachment reaches the Agent as a **file
//! path interpolated into the prompt**, never as a clipboard write plus a
//! synthesised `Ctrl+V`. That keeps the whole action to one bracketed paste and
//! one `\r`, allows more than one file, allows non-image files, and leaves the
//! user's clipboard alone.
//!
//! A file chosen from the picker already has a path and never comes here. Only
//! a **pasted bitmap** does, because a paste yields bytes with no path, so
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

// ── IPC ──

/// Save a pasted bitmap and return the path to interpolate into the prompt.
#[tauri::command]
pub fn prompt_attachment_save(bytes: Vec<u8>, extension: String) -> Result<String, AbundioError> {
    save(&bytes, &extension)
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

    #[test]
    fn sweep_on_a_missing_directory_is_harmless() {
        // Runs at startup and must never be able to stop the app opening.
        sweep();
    }
}
