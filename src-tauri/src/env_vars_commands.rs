//! The `env_*` commands over the Environment Bundle store (`env_vars.rs`,
//! ADR-0024). Plaintext still crosses IPC only one variable at a time
//! (`env_vars_reveal`); an export resolves and writes in one step.

use tauri::State;

use crate::env_crypto;
use crate::env_vars::*;
use crate::error::AbundioError;

// ── Tauri commands ──

#[tauri::command]
pub fn env_list(
    store: State<EnvVarStore>,
    workspace_id: String,
    inherit_from_workspace_id: Option<String>,
    bundle: Option<String>,
) -> Result<EnvListResult, AbundioError> {
    // A credential-store failure is soft here, unlike every other command: the
    // dialog must still be able to render variable names and offer Retry.
    let (key, key_error) = match env_crypto::master_key() {
        Ok(k) => (Some(k), None),
        Err(e) => (None, Some(e.to_string())),
    };
    let mut result = store.list(
        &workspace_id,
        inherit_from_workspace_id.as_deref(),
        bundle.as_deref(),
        key.as_ref(),
    )?;
    result.key_error = key_error;
    Ok(result)
}

#[tauri::command]
pub fn env_bundle_create(
    store: State<EnvVarStore>,
    workspace_id: String,
    inherit_from_workspace_id: Option<String>,
    name: String,
) -> Result<BundleMeta, AbundioError> {
    store.create_bundle(
        &workspace_id,
        inherit_from_workspace_id.as_deref(),
        &name,
    )
}

#[tauri::command]
pub fn env_bundle_rename(
    store: State<EnvVarStore>,
    workspace_id: String,
    from: String,
    to: String,
) -> Result<(), AbundioError> {
    store.rename_bundle(&workspace_id, &from, &to)
}

#[tauri::command]
pub fn env_bundle_set_injected(
    store: State<EnvVarStore>,
    workspace_id: String,
    inherit_from_workspace_id: Option<String>,
    name: String,
) -> Result<(), AbundioError> {
    store.set_injected(
        &workspace_id,
        inherit_from_workspace_id.as_deref(),
        &name,
    )
}

/// Turn injection off for this Workspace — no Bundle is injected until one is
/// chosen again.
#[tauri::command]
pub fn env_bundle_clear_injected(
    store: State<EnvVarStore>,
    workspace_id: String,
) -> Result<(), AbundioError> {
    store.clear_injected(&workspace_id)
}

/// Which Bundle new terminals in this Workspace receive, if any. Key-free, so
/// the status pill can poll it without a Keychain prompt.
#[tauri::command]
pub fn env_injected_summary(
    store: State<EnvVarStore>,
    workspace_id: String,
    inherit_from_workspace_id: Option<String>,
) -> Result<Option<InjectedSummary>, AbundioError> {
    store.injected_summary(&workspace_id, inherit_from_workspace_id.as_deref())
}

#[tauri::command]
pub fn env_bundle_delete(
    store: State<EnvVarStore>,
    workspace_id: String,
    name: String,
) -> Result<(), AbundioError> {
    store.delete_bundle(&workspace_id, &name)
}

#[tauri::command]
pub fn env_vars_upsert(
    store: State<EnvVarStore>,
    workspace_id: String,
    inherit_from_workspace_id: Option<String>,
    bundle: String,
    name: String,
    value: String,
) -> Result<EnvVarMeta, AbundioError> {
    let key = env_crypto::master_key()?;
    store.upsert(
        &key,
        &workspace_id,
        inherit_from_workspace_id.as_deref(),
        &bundle,
        &name,
        &value,
    )
}

#[tauri::command]
pub fn env_vars_upsert_many(
    store: State<EnvVarStore>,
    workspace_id: String,
    inherit_from_workspace_id: Option<String>,
    bundle: String,
    entries: Vec<EnvVarInput>,
) -> Result<Vec<EnvVarMeta>, AbundioError> {
    let key = env_crypto::master_key()?;
    store.upsert_many(
        &key,
        &workspace_id,
        inherit_from_workspace_id.as_deref(),
        &bundle,
        &entries,
    )
}

#[tauri::command]
pub fn env_vars_delete(
    store: State<EnvVarStore>,
    workspace_id: String,
    bundle: String,
    name: String,
) -> Result<(), AbundioError> {
    store.delete(&workspace_id, &bundle, &name)
}

#[tauri::command]
pub fn env_vars_reveal(
    store: State<EnvVarStore>,
    workspace_id: String,
    inherit_from_workspace_id: Option<String>,
    bundle: String,
    name: String,
) -> Result<String, AbundioError> {
    let key = env_crypto::master_key()?;
    store.reveal(
        &key,
        &workspace_id,
        inherit_from_workspace_id.as_deref(),
        &bundle,
        &name,
    )
}

#[tauri::command]
pub fn env_vars_reorder(
    store: State<EnvVarStore>,
    workspace_id: String,
    bundle: String,
    names: Vec<String>,
) -> Result<(), AbundioError> {
    store.reorder(&workspace_id, &bundle, &names)
}

/// Write one Bundle to `path` as `.env` text and return the path.
///
/// Rust resolves *and* writes in one step so the plaintext never crosses IPC:
/// the save dialog only supplies a path. Own rows only, and all-or-nothing —
/// see [`EnvVarStore::export_bundle`].
#[tauri::command]
pub fn env_export_to_path(
    store: State<EnvVarStore>,
    workspace_id: String,
    bundle: String,
    workspace_name: String,
    path: String,
) -> Result<String, AbundioError> {
    let key = env_crypto::master_key()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let text = store.export_bundle(&key, &workspace_id, &bundle, &workspace_name, now)?;
    write_secret_file(&path, text.as_bytes())?;
    Ok(path)
}

/// Drop the cached master key and report whether the credential store can be
/// reached now. Backs the "Retry" button after a denied or locked keychain.
/// Process-global, so it affects every window — which is the right semantics
/// for "the keychain was just unlocked".
#[tauri::command]
pub fn env_retry_key() -> bool {
    env_crypto::invalidate_cache();
    env_crypto::master_key().is_ok()
}
