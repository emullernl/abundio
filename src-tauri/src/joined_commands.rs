//! **Joined profiles**' commands (docs/plans/remote-hosts.md phase 10): the
//! list a local Profile keeps (`joined_profiles.rs`, this app's database),
//! and putting a Window on a joined Profile's Host. All desktop commands:
//! they are about this app's Windows, never run on a Host.

use tauri::{AppHandle, Manager, Window};

use crate::error::AbundioError;
use crate::joined_profiles::{self, JoinedProfile};
use crate::workspace_store::WorkspaceStore;

fn with_db<T>(app: &AppHandle, f: impl FnOnce(&rusqlite::Connection) -> Result<T, AbundioError>) -> Result<T, AbundioError> {
    let store = app.state::<WorkspaceStore>();
    let conn = store.conn.lock().map_err(|e| AbundioError::InvalidOperation(e.to_string()))?;
    f(&conn)
}

#[tauri::command]
pub fn joined_profiles_list(app: AppHandle, profile_id: String) -> Result<Vec<JoinedProfile>, AbundioError> {
    with_db(&app, |c| joined_profiles::list(c, &profile_id))
}

#[tauri::command]
pub fn joined_profile_add(
    app: AppHandle,
    profile_id: String,
    host_id: String,
    remote_profile_id: String,
    remote_profile_name: String,
) -> Result<(), AbundioError> {
    with_db(&app, |c| joined_profiles::add(c, &profile_id, &host_id, &remote_profile_id, &remote_profile_name))
}

/// Leave: the Profile stops showing it, and the Window leaves its Host.
#[tauri::command]
pub fn joined_profile_remove(app: AppHandle, window: Window, profile_id: String, host_id: String) -> Result<(), AbundioError> {
    with_db(&app, |c| joined_profiles::remove(c, &profile_id, &host_id))?;
    app.state::<std::sync::Arc<crate::host_router::HostRouter>>().leave(window.label(), &host_id);
    Ok(())
}

/// The Host listed the joined Profile's Workspaces: keep them for when it
/// cannot be reached.
#[tauri::command]
pub fn joined_profile_seen(
    app: AppHandle,
    profile_id: String,
    host_id: String,
    remote_profile_name: String,
    workspaces_json: String,
) -> Result<(), AbundioError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    with_db(&app, |c| joined_profiles::seen(c, &profile_id, &host_id, &remote_profile_name, &workspaces_json, now))
}

/// Put the calling Window on `host_id` for its joined Profile
/// `remote_profile_id`: it hears the Host, and the Host knows which Profile
/// it shows there. Connects first if need be: `ask` lets ssh ask in
/// Abundio's dialog (Join, Sign in); without it ssh never asks (app start)
/// and the Window hears why it failed, as a remote Window does.
#[tauri::command]
pub async fn host_join(
    app: AppHandle,
    window: Window,
    host_id: String,
    remote_profile_id: String,
    ask: bool,
) -> Result<(), AbundioError> {
    let label = window.label().to_string();
    let router = app.state::<std::sync::Arc<crate::host_router::HostRouter>>().inner().clone();
    // Joined first, so a failed connect is tried again for this Window.
    router.join(&label, &host_id);
    tauri::async_runtime::spawn_blocking(move || {
        crate::remote_windows::connect(&app, &host_id, ask.then_some(label.as_str()))?;
        router
            .call_on(&host_id, &label, "client_profile_set", serde_json::json!({ "profileId": remote_profile_id }))
            .map_err(crate::host_commands::remote_error)?;
        Ok(())
    })
    .await
    .map_err(|e| AbundioError::InvalidOperation(e.to_string()))?
}
