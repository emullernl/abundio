//! Where Host setup gets the server it uploads (docs/plans/remote-hosts.md
//! phase 8b): this app's own version, for the Host's platform.
//!
//! - A release build downloads `abundio-server-<platform>` and its `.sig`
//!   from the GitHub release of its own version, checks the signature with
//!   the updater's public key, and keeps it in `server-cache/<version>/`.
//! - A development build uses the server built next to it: this computer's
//!   own (`cargo build -p abundio-server`), or a Linux one built with
//!   `scripts/build-server-linux.sh`. Never cached, so a rebuild is used.

use std::path::PathBuf;

use base64::Engine;

/// Where releases live (the updater's endpoint is the same repository).
const RELEASES: &str = "https://github.com/emullernl/abundio/releases/download";

pub fn asset_name(platform: &str) -> String {
    format!("abundio-server-{platform}")
}

fn cache_path(version: &str, platform: &str) -> PathBuf {
    crate::app_paths::shared_root().join("server-cache").join(version).join(asset_name(platform))
}

/// The server binary for `platform`, as a file on this computer.
pub fn locate(app: &tauri::AppHandle, platform: &str, say: &dyn Fn(&str)) -> Result<PathBuf, String> {
    let version = env!("CARGO_PKG_VERSION");
    if cfg!(debug_assertions) {
        return dev_build(platform);
    }
    let cached = cache_path(version, platform);
    if cached.is_file() {
        return Ok(cached);
    }
    say("Downloading the server…");
    let pubkey = updater_pubkey(app).ok_or("this build has no updater key to check the server with")?;
    let url = format!("{RELEASES}/v{version}/{}", asset_name(platform));
    let bytes = download(&url)?;
    let sig = download(&format!("{url}.sig"))?;
    verify(&pubkey, &String::from_utf8_lossy(&sig), &bytes)?;
    let dir = cached.parent().ok_or("no cache folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = cached.with_extension("part");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &cached).map_err(|e| e.to_string())?;
    Ok(cached)
}

pub(crate) fn dev_build(platform: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let profile_dir = exe.parent().ok_or("no build folder")?;
    let (path, how) = match platform {
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

fn updater_pubkey(app: &tauri::AppHandle) -> Option<String> {
    app.config().plugins.0.get("updater")?.get("pubkey")?.as_str().map(str::to_string)
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    crate::updater::ensure_crypto_provider();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    rt.block_on(async {
        let client = reqwest::Client::builder()
            .user_agent(concat!("Abundio/", env!("CARGO_PKG_VERSION")))
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(url).send().await.map_err(|e| format!("cannot download the server: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("cannot download the server: {} ({url})", resp.status()));
        }
        resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
    })
}

/// Check `bytes` against a Tauri signer signature (base64 of a minisign
/// signature file) with the updater's public key (base64 of a minisign
/// public key file).
pub fn verify(pubkey_b64: &str, sig_b64: &str, bytes: &[u8]) -> Result<(), String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let text = |s: &str| -> Result<String, String> {
        String::from_utf8(b64.decode(s.trim()).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    };
    let key = minisign_verify::PublicKey::decode(&text(pubkey_b64)?).map_err(|e| format!("bad public key: {e}"))?;
    let sig = minisign_verify::Signature::decode(&text(sig_b64)?).map_err(|e| format!("bad signature: {e}"))?;
    key.verify(bytes, &sig, true).map_err(|_| "the downloaded server's signature does not match".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A server signed as CI signs it (`tauri signer sign`), checked as the
    /// app checks a download. Opt-in, on files given:
    /// `ABUNDIO_VERIFY_ASSET=<binary> ABUNDIO_VERIFY_PUBKEY=<key.pub> cargo test -p abundio -- --ignored signed_asset`
    /// (the binary's `.sig` next to it; the public key as `tauri signer
    /// generate` writes it, or as tauri.conf.json holds it).
    #[test]
    #[ignore]
    fn a_signed_asset_passes_the_apps_check() {
        let asset = std::env::var("ABUNDIO_VERIFY_ASSET").expect("ABUNDIO_VERIFY_ASSET");
        let pubkey = std::env::var("ABUNDIO_VERIFY_PUBKEY").expect("ABUNDIO_VERIFY_PUBKEY");
        let bytes = std::fs::read(&asset).unwrap();
        let sig = std::fs::read_to_string(format!("{asset}.sig")).unwrap();
        let pubkey = std::fs::read_to_string(pubkey).unwrap();
        verify(pubkey.trim(), sig.trim(), &bytes).unwrap();
        let mut damaged = bytes.clone();
        damaged[100] ^= 1;
        assert!(verify(pubkey.trim(), sig.trim(), &damaged).is_err());
    }

    // A throwaway key made for this test (`tauri signer generate`), and its
    // signature of BLOB (`tauri signer sign`).
    const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQzNUFCRkVDMEM2MEQxRUEKUldUcTBXQU03TDlhMDBuMGtLaHVqZklIYlhIUjE3WjN5TVZtdUJNUUJZd05SRFNJaWVqMFdvQ2QK";
    const SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUcTBXQU03TDlhMHg5Y1Nxb3FMZ3lqclRPYXNhdTd4YnFlUnZlTisyclpnenI4U2xQb1dNckJwSElHNEZ6NjRKQjdUMW1qRy9ldEd1NzhKdkZxZHlUS0txSC9GVWE4Q3dvPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1MTg0NDA0CWZpbGU6YmxvYgpyVjJ2aGtaM2E2UkloU3FRUE56bkxrVjRwZ1NjYi9jYVJscHZxZkp3VXRBNGYyeElDQUgyZC92ZXl1b0FWSkxtc3NVblVLZldIdmJVb2pZR2ZQL0RDZz09Cg==";
    const BLOB: &[u8] = b"abundio-server test binary\n";

    #[test]
    fn accepts_only_what_the_key_signed() {
        assert_eq!(verify(PUBKEY, SIG, BLOB), Ok(()));
        assert!(verify(PUBKEY, SIG, b"abundio-server test binarY\n").is_err());
        assert!(verify(PUBKEY, "not base64!", BLOB).is_err());
    }

    #[test]
    fn names_the_release_asset_per_platform() {
        assert_eq!(asset_name("linux-x86_64"), "abundio-server-linux-x86_64");
    }
}
