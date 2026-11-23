//! Windows showing a **Remote profile** (docs/plans/remote-hosts.md phase
//! 7d): each bound to one (Host, Profile), apart from the local Window ↔
//! Profile map (`ActiveProfileState`), since a server's Profile ids are its
//! own and may equal a local one. A remote Window's host commands go to its
//! Host (`host_router`); the Host is told which of its Profiles the Window
//! shows (`client_profile_set`, sent by the Window).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Window, Wry};

use crate::error::AbundioError;
use crate::host_router::HostRouter;

/// What a remote Window shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBinding {
    pub host_id: String,
    pub host_name: String,
    pub profile_id: String,
    pub profile_name: String,
}

#[derive(Default)]
pub struct RemoteWindows(Mutex<HashMap<String, RemoteBinding>>);

impl RemoteWindows {
    pub fn get(&self, label: &str) -> Option<RemoteBinding> {
        self.0.lock().unwrap().get(label).cloned()
    }
    pub fn remove(&self, label: &str) -> Option<RemoteBinding> {
        self.0.lock().unwrap().remove(label)
    }
    pub fn snapshot(&self) -> Vec<(String, RemoteBinding)> {
        let mut v: Vec<_> = self.0.lock().unwrap().iter().map(|(k, b)| (k.clone(), b.clone())).collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }
    /// The Window already showing this Remote profile, if any.
    fn owner(&self, host_id: &str, profile_id: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .find(|(_, b)| b.host_id == host_id && b.profile_id == profile_id)
            .map(|(l, _)| l.clone())
    }
}

pub fn title_for(b: &RemoteBinding) -> String {
    format!("Abundio - {} profile ☁ {}", b.profile_name, b.host_name)
}

fn router(app: &AppHandle) -> std::sync::Arc<HostRouter> {
    app.state::<std::sync::Arc<HostRouter>>().inner().clone()
}

/// Connect to a Host the user added, unless already connected. `ask`:
/// SSH prompts (a password, a passphrase, a new host key) are answered in
/// Abundio's dialog; without it ssh never asks (app start), and the Host's
/// Windows hear why it failed (`host-connect-failed`: "Sign in needed", or
/// unreachable and tried again in the background).
pub fn connect(app: &AppHandle, host_id: &str, ask: Option<&str>) -> Result<String, AbundioError> {
    use tauri::Emitter;
    let host = crate::hosts::find(host_id).ok_or_else(|| AbundioError::NotFound("that Host was removed".into()))?;
    let router = router(app);
    let result = with_ssh_mode(app, &host.name, ask, |mode| router.connect(host_id, &host.target, mode));
    let ask = ask.is_some();
    if let Err(reason) = &result {
        let sign_in = crate::host_router::needs_sign_in(reason);
        for window in router.windows_on(host_id) {
            let _ = app.emit_to(
                window.as_str(),
                "host-connect-failed",
                serde_json::json!({ "host": host_id, "reason": reason, "signIn": sign_in }),
            );
        }
        // A Host that is only unreachable (asleep, offline) is tried again
        // in the background; one that needs the user waits for Sign in.
        if !ask && !sign_in {
            router.retry_in_background(host_id, crate::host_router::BACKOFF[0]);
        }
    }
    result.map_err(AbundioError::Channel)
}

/// Run `f` with the way ssh may ask: in Abundio's dialog, shown in Window
/// `ask` (a one-time askpass token for this one ssh), or never (`None`).
pub fn with_ssh_mode<T>(
    app: &AppHandle,
    host_name: &str,
    ask: Option<&str>,
    f: impl FnOnce(&crate::host_router::ConnectMode) -> T,
) -> T {
    let Some(window) = ask else {
        return f(&crate::host_router::ConnectMode::Batch);
    };
    let askpass = app.state::<crate::askpass::Askpass>();
    let token = askpass.issue(host_name, Some(window));
    let mode = crate::host_router::ConnectMode::Interactive(crate::askpass::Askpass::env(
        &askpass_script(),
        app.state::<crate::hook_server::HookServer>().port,
        &token,
    ));
    let r = f(&mode);
    askpass.revoke(&token);
    r
}

/// Where the SSH prompt helper is (written at app start).
pub fn askpass_script() -> std::path::PathBuf {
    crate::app_paths::shared_root().join("askpass").join("abundio-askpass")
}

/// Open `binding` in a Window: the one already showing it (focused), or a
/// new one. `restore` gives the label and placement of a Window reopened at
/// app start.
pub fn open(
    app: &AppHandle<Wry>,
    binding: RemoteBinding,
    restore: Option<(String, Option<crate::window_placement::Remembered>)>,
) -> Result<String, AbundioError> {
    let windows = app.state::<RemoteWindows>();
    if let Some(label) = windows.owner(&binding.host_id, &binding.profile_id) {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.set_focus();
        }
        return Ok(label);
    }
    let (label, placement, restoring) = match restore {
        Some((l, p)) if !app.webview_windows().contains_key(&l) => (l, p, true),
        Some((_, p)) => (crate::window_management::generate_window_label(), p, true),
        None => (crate::window_management::generate_window_label(), None, false),
    };
    // Bound before the Window loads, so its first host command goes there.
    router(app).bind(&label, Some(&binding.host_id));
    windows.0.lock().unwrap().insert(label.clone(), binding.clone());
    match crate::window_management::build_profile_window(app, &label, &title_for(&binding), restoring, placement) {
        Ok(_) => {
            crate::rebuild_menu_for_focused_window(app);
            Ok(label)
        }
        Err(e) => {
            windows.remove(&label);
            router(app).bind(&label, None);
            Err(AbundioError::InvalidOperation(format!("Window build failed: {e}")))
        }
    }
}

/// A remote Window closed: forget it here and on its Host.
pub fn on_destroyed(app: &AppHandle, label: &str) {
    app.state::<RemoteWindows>().remove(label);
    router(app).window_closed(label);
}

// ── Commands ──

/// What the calling Window shows, when it is a remote one.
#[tauri::command]
pub fn remote_profile_for_window(window: Window, windows: tauri::State<'_, RemoteWindows>) -> Option<RemoteBinding> {
    windows.get(window.label())
}

/// Connect to a Host the user added (Open Remote Profile). Blocks for the
/// handshake.
#[tauri::command]
pub async fn host_connect_saved(app: AppHandle, window: Window, host_id: String) -> Result<String, AbundioError> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || connect(&app, &host_id, Some(&label)))
        .await
        .map_err(|e| AbundioError::InvalidOperation(e.to_string()))?
}

/// Run a host command on a Host the calling Window is not bound to (Open
/// Remote Profile lists and creates the Host's Profiles from a local Window).
#[tauri::command]
pub async fn host_request(
    app: AppHandle,
    window: Window,
    host_id: String,
    command: String,
    args: Value,
) -> Result<Value, AbundioError> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        router(&app)
            .call_on(&host_id, &label, &command, args)
            .map_err(crate::host_commands::remote_error)
    })
    .await
    .map_err(|e| AbundioError::InvalidOperation(e.to_string()))?
}

/// The user's answer to an SSH prompt (`None`: cancelled).
#[tauri::command]
pub fn ssh_prompt_answer(app: AppHandle, id: String, answer: Option<String>) -> bool {
    app.state::<crate::askpass::Askpass>().answer(&id, answer)
}

/// Open a Host's Profile in a Window of its own (connected first).
#[tauri::command]
pub async fn open_remote_profile_window(
    app: AppHandle,
    window: Window,
    host_id: String,
    profile_id: String,
    profile_name: String,
) -> Result<String, AbundioError> {
    let host = crate::hosts::find(&host_id).ok_or_else(|| AbundioError::NotFound("that Host was removed".into()))?;
    // Never shown twice in this app: not while a Window has it joined.
    if joined_in(&app, &host_id, &profile_id, None)? {
        return Err(AbundioError::InvalidOperation(format!(
            "{profile_name} is joined in another Window: Leave it there to open it in a Window of its own"
        )));
    }
    let app2 = app.clone();
    let id = host_id.clone();
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || connect(&app2, &id, Some(&label)))
        .await
        .map_err(|e| AbundioError::InvalidOperation(e.to_string()))??;
    open(
        &app,
        RemoteBinding { host_id, host_name: host.name, profile_id, profile_name },
        None,
    )
}

/// A Remote profile shown in a Window of its own: its label.
pub fn window_showing(app: &AppHandle, host_id: &str, profile_id: &str) -> Option<String> {
    app.state::<RemoteWindows>().owner(host_id, profile_id)
}

/// Whether an open Profile window other than `except` has this Remote
/// profile joined (phase 10b): its local Profile lists it.
pub fn joined_in(
    app: &AppHandle,
    host_id: &str,
    profile_id: &str,
    except: Option<&str>,
) -> Result<bool, AbundioError> {
    let owners = app.state::<crate::profile_store::ActiveProfileState>().snapshot();
    let store = app.state::<crate::workspace_store::WorkspaceStore>();
    let conn = store.conn.lock().map_err(|e| AbundioError::InvalidOperation(e.to_string()))?;
    let mut open = Vec::new();
    for (label, local) in owners {
        if app.get_webview_window(&label).is_none() {
            continue;
        }
        open.push((label, crate::joined_profiles::list(&conn, &local)?));
    }
    Ok(joined_by_any(&open, host_id, profile_id, except))
}

/// Whether one of the open Windows (label, its local Profile's Joined
/// profiles), `except` aside, has this Remote profile joined. Pure.
pub fn joined_by_any(
    windows: &[(String, Vec<crate::joined_profiles::JoinedProfile>)],
    host_id: &str,
    profile_id: &str,
    except: Option<&str>,
) -> bool {
    windows.iter().any(|(label, joined)| {
        Some(label.as_str()) != except
            && joined.iter().any(|j| j.host_id == host_id && j.remote_profile_id == profile_id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn joined(host: &str, profile: &str) -> crate::joined_profiles::JoinedProfile {
        crate::joined_profiles::JoinedProfile {
            host_id: host.into(),
            remote_profile_id: profile.into(),
            remote_profile_name: profile.into(),
            workspaces_json: "[]".into(),
            last_seen_ms: None,
        }
    }

    #[test]
    fn a_remote_profile_joined_in_an_open_window_is_taken() {
        let windows = vec![
            ("main".to_string(), vec![joined("box", "p1")]),
            ("window-2".to_string(), vec![joined("lab", "p9")]),
        ];
        assert!(joined_by_any(&windows, "box", "p1", None));
        // Its own Window asking (a restored join connecting) is not a clash.
        assert!(!joined_by_any(&windows, "box", "p1", Some("main")));
        // Another Profile of that Host, or that id on another Host, is free.
        assert!(!joined_by_any(&windows, "box", "p2", None));
        assert!(!joined_by_any(&windows, "lab", "p1", None));
    }

    #[test]
    fn a_remote_window_says_where_it_is() {
        let b = RemoteBinding {
            host_id: "h".into(),
            host_name: "build-box".into(),
            profile_id: "p".into(),
            profile_name: "Work".into(),
        };
        assert_eq!(title_for(&b), "Abundio - Work profile ☁ build-box");
        let w = RemoteWindows::default();
        w.0.lock().unwrap().insert("window-1".into(), b.clone());
        assert_eq!(w.owner("h", "p").as_deref(), Some("window-1"));
        assert_eq!(w.owner("h", "other"), None);
        assert_eq!(w.owner("other", "p"), None);
    }
}
