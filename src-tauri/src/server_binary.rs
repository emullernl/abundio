//! Where Host setup gets the server it uploads (docs/plans/remote-hosts.md
//! phase 8b, phase 15): this app's own version, for the Host's platform.
//!
//! - A release build carries all three servers, gzipped, in its resources
//!   (`server/abundio-server-<platform>.gz`, written by CI): nothing is
//!   downloaded, and the app's own signing covers them.
//! - A development build uses the server built next to it: this computer's
//!   own (`cargo build -p abundio-server`), or a Linux one built with
//!   `scripts/build-server-linux.sh`, so a rebuild is used.

use std::io::{Read, Write};
use std::path::PathBuf;

use sha2::Digest;
use tauri::Manager;

pub fn asset_name(platform: &str) -> String {
    format!("abundio-server-{platform}")
}

/// What Install sends: the server's own SHA-256 and size (checked on the
/// Host after unpacking), and the bytes to upload.
pub struct ServerUpload {
    pub sha: String,
    pub size: usize,
    pub upload: Vec<u8>,
    /// `upload` is gzipped, for the Host to unpack with `gzip`.
    pub gzipped: bool,
}

/// The server for `platform`, ready to upload: gzipped when the Host has
/// `gzip`, else as it is.
pub fn locate(app: &tauri::AppHandle, platform: &str, host_has_gzip: bool) -> Result<ServerUpload, String> {
    let (raw, packed) = if cfg!(debug_assertions) {
        (std::fs::read(dev_build(platform)?).map_err(|e| e.to_string())?, None)
    } else {
        let gz = std::fs::read(bundled(app, platform)?).map_err(|e| e.to_string())?;
        (gunzip(&gz)?, Some(gz))
    };
    let sha = format!("{:x}", sha2::Sha256::digest(&raw));
    let size = raw.len();
    Ok(if host_has_gzip {
        let upload = match packed {
            Some(gz) => gz,
            None => gzip(&raw)?,
        };
        ServerUpload { sha, size, upload, gzipped: true }
    } else {
        ServerUpload { sha, size, upload: raw, gzipped: false }
    })
}

/// The bundled server for `platform`, in this app's resources.
fn bundled(app: &tauri::AppHandle, platform: &str) -> Result<PathBuf, String> {
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let path = dir.join("server").join(format!("{}.gz", asset_name(platform)));
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("this build of Abundio carries no server for {platform}"))
    }
}

pub fn gunzip(gz: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(gz)
        .read_to_end(&mut out)
        .map_err(|e| format!("the bundled server is damaged: {e}"))?;
    Ok(out)
}

pub fn gzip(raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    enc.write_all(raw).map_err(|e| e.to_string())?;
    enc.finish().map_err(|e| e.to_string())
}

pub(crate) fn dev_build(platform: &str) -> Result<PathBuf, String> {
    // nosemgrep: rust.lang.security.current-exe.current-exe -- debug builds only (cfg!(debug_assertions) at both callers); finds the dev server next to the app
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let profile_dir = exe.parent().ok_or("no build folder")?;
    let (path, how) = match platform {
        // A development build's own server, for a Mac Host: built for this
        // Mac's chip only, which is the Host's when it is this kind of Mac.
        "macos-universal" if cfg!(target_os = "macos") => {
            (profile_dir.join("abundio-server"), "cargo build -p abundio-server (in src-tauri)".to_string())
        }
        p if p.starts_with("linux-") => {
            let arch = p.trim_start_matches("linux-");
            (
                profile_dir.parent().ok_or("no target folder")?.join("server-dist").join(p).join("abundio-server"),
                format!("scripts/build-server-linux.sh {arch}"),
            )
        }
        p => return Err(format!("a development build cannot make a server for {p}")),
    };
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("no development server for {platform}; build it first: {how}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gzipped_server_unpacks_to_the_same_bytes() {
        let raw: Vec<u8> = (0..100_000u32).flat_map(|i| (i % 251).to_le_bytes()).collect();
        let gz = gzip(&raw).unwrap();
        assert!(gz.len() < raw.len());
        assert_eq!(gunzip(&gz).unwrap(), raw);
        assert!(gunzip(b"not gzip").is_err());
        assert_eq!(asset_name("linux-x86_64"), "abundio-server-linux-x86_64");
    }
}
