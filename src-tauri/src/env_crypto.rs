//! Crypto and key management for per-Workspace environment variables.
//!
//! One 32-byte master key lives in the OS credential store (macOS Keychain,
//! Windows Credential Manager, Linux Secret Service). Every variable VALUE is
//! sealed with AES-256-GCM under that key before it touches SQLite, so a copy
//! of `abundio.db` on its own is useless. Variable NAMES stay plaintext — they
//! are needed to build a shell environment and to render the settings list
//! without prompting for keychain access.
//!
//! This module deliberately knows nothing about SQLite or Tauri. That keeps its
//! tests runnable with an injected key and no keychain, which matters because
//! CI has no unlocked credential store.
//!
//! ## What this does and does not protect
//!
//! It protects data **at rest**: a disk-scraping infostealer that copies the
//! database, or a stray backup, yields ciphertext. It does **not** protect
//! against a process running as the same user — once injected, values are
//! readable via `env` by anything in that PTY, and the key itself is reachable
//! by anything that can drive the credential store as you. See ADR-0024.

use std::sync::Mutex;

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    Aes256Gcm, Key, Nonce,
};
use zeroize::{Zeroize, Zeroizing};

use crate::error::AbundioError;

/// Credential-store service name. Shared by every Abundio install for this user.
pub const KEYRING_SERVICE: &str = "abundio";
/// Credential-store entry name holding the raw 32-byte master key.
pub const KEYRING_ENTRY: &str = "env-master-key";

/// AES-256-GCM authentication tag length. Sealed blobs are
/// `plaintext.len() + TAG_LEN` bytes, which is the identity the list IPC uses
/// to report a value's size without decrypting it.
pub const TAG_LEN: usize = 16;
/// AES-GCM nonce length (96 bits, the recommended size).
pub const NONCE_LEN: usize = 12;
/// Master key length for AES-256.
pub const KEY_LEN: usize = 32;

/// Longest permitted variable name.
pub const MAX_NAME_BYTES: usize = 256;
/// Longest permitted single value. Generous enough for a certificate chain.
pub const MAX_VALUE_BYTES: usize = 32 * 1024;

/// Total `name + value` bytes allowed in a Workspace's *injected* Bundle,
/// before the shadow-variable doubling in `pty_manager`.
///
/// Windows caps a process's whole environment block at 32,767 characters and
/// `CreateProcess` FAILS on overflow — which would kill the pane outright and
/// violate "a keychain problem must never block a spawn". The budget is
/// therefore much tighter there. On-demand Bundles are not subject to this at
/// all: they never enter an environment block.
#[cfg(windows)]
pub const MAX_INJECTED_BYTES: usize = 8 * 1024;
#[cfg(not(windows))]
pub const MAX_INJECTED_BYTES: usize = 64 * 1024;

/// Prefix for the shadow copy the wrapper rc re-exports after the user's rc.
pub const SHADOW_PREFIX: &str = "ABUNDIO_ENV__";

/// Bytes one variable adds to the child's environment block.
///
/// Every variable is emitted TWICE (its own name plus the `ABUNDIO_ENV__`
/// shadow) and once more in the space-separated manifest. The settings UI and
/// the spawn path MUST agree on this, or the "Add" form would accept a variable
/// the spawn path then silently drops.
pub fn injection_cost(name_len: usize, value_len: usize) -> usize {
    (name_len + value_len + 2) * 2 + SHADOW_PREFIX.len() + name_len + 1
}

/// Environment variables Abundio owns. A user variable may not shadow these:
/// `ABUNDIO_HOOK_TOKEN` / `ABUNDIO_PTY_ID` drive agent-status correlation
/// (`hook_server.rs`), and `ZDOTDIR` / `TERM*` drive shell integration.
const RESERVED_NAMES: &[&str] = &[
    "TERM",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "PROMPT_EOL_MARK",
    "ZDOTDIR",
    "CHERE_INVOKING",
];

/// Prefix reserved for Abundio-owned variables, including the `ABUNDIO_ENV__`
/// shadow variables and `ABUNDIO_ENV_KEYS`.
const RESERVED_PREFIX: &str = "ABUNDIO_";

/// Dev-only override so `pnpm tauri dev` does not prompt for keychain access on
/// every rebuild. macOS binds keychain ACLs to the code signature, and an
/// ad-hoc dev signature changes on each build, so every launch otherwise looks
/// like a brand-new application asking for your secrets.
#[cfg(debug_assertions)]
const DEV_KEY_ENV: &str = "ABUNDIO_DEV_ENV_KEY";

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    /// The credential store is missing, locked, or access was denied. Callers
    /// must treat this as "feature unavailable", never as a fatal error.
    #[error("credential store unavailable: {0}")]
    Keyring(String),
    /// Wrong key, tampered ciphertext, or a name/ciphertext mismatch. Carries
    /// no detail on purpose — it must never leak plaintext into an error string
    /// that gets serialized to the frontend.
    #[error("decryption failed")]
    Decrypt,
    /// The credential store returned something that is not a 32-byte key.
    #[error("malformed key material in credential store")]
    BadKey,
}

impl From<CryptoError> for AbundioError {
    fn from(e: CryptoError) -> Self {
        AbundioError::Crypto(e.to_string())
    }
}

/// A 32-byte AES-256 master key, wiped from memory on drop.
#[derive(Clone)]
pub struct MasterKey([u8; KEY_LEN]);

impl Drop for MasterKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl MasterKey {
    pub fn generate() -> Self {
        let key = Aes256Gcm::generate_key(&mut OsRng);
        let mut bytes = [0u8; KEY_LEN];
        bytes.copy_from_slice(key.as_slice());
        Self(bytes)
    }

    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.0))
    }
}

/// Process-wide cache of the master key.
///
/// A `Mutex<Option<_>>` rather than a `OnceLock`: the first read can legitimately
/// fail (the user dismissed the keychain prompt, or the Secret Service is not
/// running), and the UI's Retry must be able to try again.
static KEY_CACHE: Mutex<Option<MasterKey>> = Mutex::new(None);

/// Fetch the master key, generating and storing one on first use.
///
/// Cached process-wide after the first success — which means it is shared by
/// every window, since a Tauri app is a single process.
pub fn master_key() -> Result<MasterKey, CryptoError> {
    if let Some(key) = KEY_CACHE.lock().unwrap().as_ref() {
        return Ok(key.clone());
    }

    #[cfg(debug_assertions)]
    if let Ok(hex) = std::env::var(DEV_KEY_ENV) {
        let key = parse_hex_key(&hex)?;
        *KEY_CACHE.lock().unwrap() = Some(key.clone());
        log::warn!("[env] using {DEV_KEY_ENV} instead of the OS credential store (debug build)");
        return Ok(key);
    }

    let key = load_or_create_keyring_key()?;
    *KEY_CACHE.lock().unwrap() = Some(key.clone());
    Ok(key)
}

/// Drop the cached key so the next `master_key()` re-reads the credential
/// store. Backs the UI's Retry button after a denied or locked keychain.
pub fn invalidate_cache() {
    *KEY_CACHE.lock().unwrap() = None;
}

fn load_or_create_keyring_key() -> Result<MasterKey, CryptoError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ENTRY)
        .map_err(|e| CryptoError::Keyring(e.to_string()))?;

    match entry.get_secret() {
        Ok(bytes) => {
            if bytes.len() != KEY_LEN {
                return Err(CryptoError::BadKey);
            }
            let mut arr = [0u8; KEY_LEN];
            arr.copy_from_slice(&bytes);
            Ok(MasterKey::from_bytes(arr))
        }
        Err(keyring::Error::NoEntry) => {
            // First run on this machine: mint a key and store it.
            let key = MasterKey::generate();
            entry
                .set_secret(&key.0)
                .map_err(|e| CryptoError::Keyring(e.to_string()))?;
            log::info!("[env] created a new environment-variable master key in the OS credential store");
            Ok(key)
        }
        Err(e) => Err(CryptoError::Keyring(e.to_string())),
    }
}

#[cfg(debug_assertions)]
fn parse_hex_key(hex: &str) -> Result<MasterKey, CryptoError> {
    let hex = hex.trim();
    if hex.len() != KEY_LEN * 2 {
        return Err(CryptoError::BadKey);
    }
    let mut bytes = [0u8; KEY_LEN];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let s = std::str::from_utf8(chunk).map_err(|_| CryptoError::BadKey)?;
        bytes[i] = u8::from_str_radix(s, 16).map_err(|_| CryptoError::BadKey)?;
    }
    Ok(MasterKey::from_bytes(bytes))
}

/// Seal a value. Returns `(nonce, ciphertext_with_tag)`.
///
/// The variable name is used as associated data, binding the ciphertext to its
/// name: someone editing the database by hand cannot move a sealed value under
/// a different variable name and have it decrypt. This is why there is no
/// rename operation — changing a name is delete + add.
pub fn seal(
    key: &MasterKey,
    name: &str,
    plaintext: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), CryptoError> {
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = key
        .cipher()
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: name.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::Decrypt)?;
    Ok((nonce.to_vec(), ciphertext))
}

/// Open a sealed value. The plaintext is wiped on drop.
pub fn open(
    key: &MasterKey,
    name: &str,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if nonce.len() != NONCE_LEN {
        return Err(CryptoError::Decrypt);
    }
    let plaintext = key
        .cipher()
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: name.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::Decrypt)?;
    Ok(Zeroizing::new(plaintext))
}

/// Plaintext byte length of a sealed value, derived without decrypting.
pub fn plaintext_len(ciphertext_len: usize) -> i64 {
    ciphertext_len.saturating_sub(TAG_LEN) as i64
}

/// True when `name` is owned by Abundio and may not be used for a workspace
/// variable. Compared case-insensitively because Windows environment variable
/// names are case-insensitive.
pub fn is_reserved_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with(RESERVED_PREFIX) || RESERVED_NAMES.contains(&upper.as_str())
}

/// Validate a variable name.
///
/// Must be a POSIX shell identifier. This is a security boundary, not a
/// cosmetic check: the wrapper rc scripts iterate these names, and anything
/// containing whitespace would also corrupt the space-separated
/// `ABUNDIO_ENV_KEYS` manifest.
pub fn validate_name(name: &str) -> Result<(), AbundioError> {
    if name.is_empty() {
        return Err(AbundioError::InvalidOperation(
            "Variable name cannot be empty".into(),
        ));
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(AbundioError::InvalidOperation(format!(
            "Variable name is too long (max {MAX_NAME_BYTES} bytes)"
        )));
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err(AbundioError::InvalidOperation(format!(
            "'{name}' is not a valid variable name (must start with a letter or underscore)"
        )));
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(AbundioError::InvalidOperation(format!(
            "'{name}' is not a valid variable name (letters, digits and underscore only)"
        )));
    }
    if is_reserved_name(name) {
        return Err(AbundioError::InvalidOperation(format!(
            "'{name}' is reserved by Abundio"
        )));
    }
    Ok(())
}

/// Validate a value's size before it is sealed.
pub fn validate_value(value: &str) -> Result<(), AbundioError> {
    if value.len() > MAX_VALUE_BYTES {
        return Err(AbundioError::InvalidOperation(format!(
            "Value is too large ({} bytes, max {MAX_VALUE_BYTES})",
            value.len()
        )));
    }
    Ok(())
}

/// Validate a Bundle name. Looser than a variable name — it is a label, never
/// interpolated into a shell — but it travels in an `abundio-env print <name>`
/// argument and a JSON body, so keep it boring.
pub fn validate_bundle_name(name: &str) -> Result<(), AbundioError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AbundioError::InvalidOperation(
            "Bundle name cannot be empty".into(),
        ));
    }
    if trimmed.len() > 64 {
        return Err(AbundioError::InvalidOperation(
            "Bundle name is too long (max 64 characters)".into(),
        ));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(AbundioError::InvalidOperation(
            "Bundle name may contain letters, digits, dot, dash and underscore only".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every test uses an injected key. Nothing here touches the real
    /// credential store — CI has none, and a `master_key()` call would hang on
    /// a prompt or fail outright.
    fn test_key() -> MasterKey {
        MasterKey::from_bytes([7u8; KEY_LEN])
    }

    #[test]
    fn seal_open_round_trips() {
        let key = test_key();
        for value in [
            "",
            "hello",
            "ghp_A1b2C3d4E5f6",
            "-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+g\nline3\n-----END CERTIFICATE-----\n",
            "unicode: äöü 🎉 \u{1F600}",
        ] {
            let (nonce, ct) = seal(&key, "MY_VAR", value.as_bytes()).unwrap();
            let out = open(&key, "MY_VAR", &nonce, &ct).unwrap();
            assert_eq!(String::from_utf8(out.to_vec()).unwrap(), value);
        }
    }

    #[test]
    fn nonce_and_ciphertext_differ_per_seal() {
        let key = test_key();
        let (n1, c1) = seal(&key, "A", b"same").unwrap();
        let (n2, c2) = seal(&key, "A", b"same").unwrap();
        assert_ne!(n1, n2, "nonce must be random per seal");
        assert_ne!(c1, c2, "identical plaintext must not produce identical ciphertext");
    }

    #[test]
    fn open_with_wrong_key_fails() {
        let (nonce, ct) = seal(&test_key(), "A", b"secret").unwrap();
        let other = MasterKey::from_bytes([9u8; KEY_LEN]);
        assert!(matches!(
            open(&other, "A", &nonce, &ct),
            Err(CryptoError::Decrypt)
        ));
    }

    #[test]
    fn open_with_tampered_ciphertext_fails() {
        let key = test_key();
        let (nonce, mut ct) = seal(&key, "A", b"secret").unwrap();
        ct[0] ^= 0xff;
        assert!(matches!(open(&key, "A", &nonce, &ct), Err(CryptoError::Decrypt)));
    }

    /// The AAD binding: a sealed value cannot be moved under another name.
    #[test]
    fn open_with_mismatched_name_fails() {
        let key = test_key();
        let (nonce, ct) = seal(&key, "REAL_NAME", b"secret").unwrap();
        assert!(matches!(
            open(&key, "OTHER_NAME", &nonce, &ct),
            Err(CryptoError::Decrypt)
        ));
    }

    #[test]
    fn open_with_bad_nonce_length_fails() {
        let key = test_key();
        let (_, ct) = seal(&key, "A", b"secret").unwrap();
        assert!(matches!(open(&key, "A", &[0u8; 5], &ct), Err(CryptoError::Decrypt)));
    }

    /// Locks the size derivation the list IPC depends on. If this breaks, the
    /// UI silently reports wrong byte sizes for every variable.
    #[test]
    fn ciphertext_is_plaintext_len_plus_tag() {
        let key = test_key();
        for len in [0usize, 1, 40, 3182] {
            let plaintext = vec![b'x'; len];
            let (_, ct) = seal(&key, "A", &plaintext).unwrap();
            assert_eq!(ct.len(), len + TAG_LEN);
            assert_eq!(plaintext_len(ct.len()), len as i64);
        }
    }

    #[test]
    fn validate_name_accepts_identifiers() {
        for name in ["FOO", "_A1", "a", "MY_VAR_2", "PATH"] {
            assert!(validate_name(name).is_ok(), "{name} should be accepted");
        }
    }

    #[test]
    fn validate_name_rejects_non_identifiers() {
        for name in ["", "1FOO", "FOO-BAR", "FOO BAR", "FOO=", "FÖÖ", "a\"; rm -rf ~"] {
            assert!(validate_name(name).is_err(), "{name:?} should be rejected");
        }
    }

    #[test]
    fn validate_name_rejects_overlong() {
        let long = "A".repeat(MAX_NAME_BYTES + 1);
        assert!(validate_name(&long).is_err());
    }

    #[test]
    fn rejects_abundio_prefix_case_insensitively() {
        for name in ["ABUNDIO_X", "abundio_x", "Abundio_X", "ABUNDIO_HOOK_TOKEN"] {
            assert!(is_reserved_name(name), "{name} should be reserved");
            assert!(validate_name(name).is_err());
        }
    }

    #[test]
    fn rejects_each_reserved_name() {
        for name in RESERVED_NAMES {
            assert!(is_reserved_name(name));
            assert!(validate_name(name).is_err(), "{name} should be rejected");
            assert!(validate_name(&name.to_lowercase()).is_err());
        }
    }

    #[test]
    fn validate_value_enforces_size() {
        assert!(validate_value("ok").is_ok());
        assert!(validate_value(&"x".repeat(MAX_VALUE_BYTES)).is_ok());
        assert!(validate_value(&"x".repeat(MAX_VALUE_BYTES + 1)).is_err());
    }

    #[test]
    fn validate_bundle_name_rules() {
        for ok in ["default", "production", "stage-1", "a.b_c"] {
            assert!(validate_bundle_name(ok).is_ok(), "{ok} should be accepted");
        }
        for bad in ["", "   ", "has space", "quote\"", &"x".repeat(65)] {
            assert!(validate_bundle_name(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    /// Touches the REAL OS credential store, so it is ignored by default: CI
    /// has no unlocked keychain and this would hang on a prompt or fail.
    /// Run it by hand once per platform when changing anything about key
    /// storage:  `cargo test keychain_round_trip -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn keychain_round_trip() {
        let service = "abundio-test";
        let name = "env-master-key-test";
        let entry = keyring::Entry::new(service, name).expect("credential store unavailable");
        let secret = [42u8; KEY_LEN];
        entry.set_secret(&secret).expect("set_secret failed");
        let got = entry.get_secret().expect("get_secret failed");
        assert_eq!(got, secret.to_vec());
        entry.delete_credential().expect("delete failed");
        println!("credential store round-trip OK");
    }

    #[cfg(debug_assertions)]
    #[test]
    fn parse_hex_key_round_trips() {
        let hex = "00".repeat(KEY_LEN);
        assert!(parse_hex_key(&hex).is_ok());
        assert!(parse_hex_key("abc").is_err());
        assert!(parse_hex_key(&"zz".repeat(KEY_LEN)).is_err());
    }
}
