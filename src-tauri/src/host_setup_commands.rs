//! Host setup's commands (docs/plans/remote-hosts.md phase 8): Settings ▸
//! Hosts asks what a Host has (`host_check`), and installs, starts, updates
//! or removes the server there. Each is a short `ssh` of its own; SSH
//! prompts show in the Window that asked.

use std::time::Duration;

use abundio_core::host_setup::{self, CheckItem, Probe};
use serde::Serialize;
use tauri::{AppHandle, Window};

use crate::error::AbundioError;

/// Sent to every Window when a Host's server was just installed or started:
/// one whose Host was not set up connects again.
const SERVER_READY_EVENT: &str = "host-server-ready";

/// How long a setup step may take, a password prompt included.
const STEP_LIMIT: Duration = Duration::from_secs(330);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCheck {
    pub probe: Probe,
    pub items: Vec<CheckItem>,
    pub app_version: &'static str,
}

/// Probe a Host and make its checklist. `agents`: the commands of the
/// user's Agents, to look for there.
#[tauri::command]
pub async fn host_check(
    app: AppHandle,
    window: Window,
    host_id: String,
    agents: Vec<String>,
) -> Result<HostCheck, AbundioError> {
    let host = crate::hosts::find(&host_id).ok_or_else(|| AbundioError::NotFound("that Host was removed".into()))?;
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut words: Vec<&str> = agents.iter().filter_map(|a| host_setup::probe_word(a)).collect();
        words.sort_unstable();
        words.dedup();
        let out = crate::remote_windows::with_ssh_mode(&app, &host.name, Some(&label), |mode| {
            host_setup::run_script(host.target.shell(mode, &words), host_setup::PROBE_SCRIPT, STEP_LIMIT)
        })
        .map_err(AbundioError::Channel)?;
        let probe = host_setup::parse_probe(&out);
        let app_version = env!("CARGO_PKG_VERSION");
        let mut items = host_setup::checklist(&probe, app_version);
        if cfg!(debug_assertions) {
            if let Some(sha) = dev_build_sha(&probe) {
                host_setup::mark_rebuilt_server(&mut items, &probe, app_version, &sha);
            }
        }
        Ok(HostCheck { items, probe, app_version })
    })
    .await
    .map_err(|e| AbundioError::InvalidOperation(e.to_string()))?
}

/// The SHA-256 of the server a development build would install on this
/// Host, if it has been built.
fn dev_build_sha(probe: &Probe) -> Option<String> {
    use sha2::Digest;
    let platform = host_setup::platform(&probe.os, &probe.arch).ok()?;
    let bytes = std::fs::read(crate::server_binary::dev_build(platform).ok()?).ok()?;
    Some(format!("{:x}", sha2::Sha256::digest(&bytes)))
}

/// How long an install may take: the upload over a slow link.
const INSTALL_LIMIT: Duration = Duration::from_secs(30 * 60);

/// What Host setup is doing now, for the Window that asked.
pub const PROGRESS_EVENT: &str = "host-setup-progress";

/// Install this app's server on a Host (phase 8b): the binary for the
/// platform its last Check found (`os`, `arch`; the Host refuses it if that
/// changed), uploaded in the same ssh that installs it and checks again, so
/// a Host that asks for a password asks once. Answers with the new
/// checklist.
#[tauri::command]
pub async fn host_install(
    app: AppHandle,
    window: Window,
    host_id: String,
    os: String,
    arch: String,
    agents: Vec<String>,
) -> Result<HostCheck, AbundioError> {
    use sha2::Digest;
    use tauri::Emitter;
    let host = crate::hosts::find(&host_id).ok_or_else(|| AbundioError::NotFound("that Host was removed".into()))?;
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let say = |text: &str| {
            let _ = app.emit_to(label.as_str(), PROGRESS_EVENT, serde_json::json!({ "hostId": host_id, "text": text }));
        };
        let platform = host_setup::platform(&os, &arch).map_err(AbundioError::InvalidOperation)?;
        let binary = crate::server_binary::locate(&app, platform, &say).map_err(AbundioError::InvalidOperation)?;
        let bytes = std::fs::read(&binary)?;
        let sha = format!("{:x}", sha2::Sha256::digest(&bytes));
        let size = bytes.len().to_string();
        let version = env!("CARGO_PKG_VERSION");
        let mut args: Vec<&str> = vec![&os, &arch, version, &sha, &size];
        let mut words: Vec<&str> = agents.iter().filter_map(|a| host_setup::probe_word(a)).collect();
        words.sort_unstable();
        words.dedup();
        args.extend(words);
        say(&format!("Uploading the server ({} MB)…", bytes.len() / 1_000_000));
        let out = crate::remote_windows::with_ssh_mode(&app, &host.name, Some(&label), |mode| {
            host_setup::run(
                host.target.sh_c(mode, &host_setup::install_then_probe(), &args),
                Box::new(std::io::Cursor::new(bytes)),
                INSTALL_LIMIT,
            )
        })
        .map_err(AbundioError::Channel)?;
        let probe = host_setup::parse_probe(&out);
        if probe.installed_now.as_deref() != Some(version) {
            return Err(AbundioError::Channel("the install did not finish".into()));
        }
        log::info!("[host] installed server {version} on {}", host.name);
        // Windows waiting on this Host (another server version) connect again.
        let _ = app.emit(SERVER_READY_EVENT, &host_id);
        Ok(HostCheck { items: host_setup::checklist(&probe, version), probe, app_version: version })
    })
    .await
    .map_err(|e| AbundioError::InvalidOperation(e.to_string()))?
}

/// Start the installed server on a Host as a service (phase 8c), then check
/// again, in one ssh. `restart`: stop the one running first (phase 8d: to
/// move a server running by itself into a service). Answers with the new
/// checklist.
#[tauri::command]
pub async fn host_start(
    app: AppHandle,
    window: Window,
    host_id: String,
    restart: bool,
    agents: Vec<String>,
) -> Result<HostCheck, AbundioError> {
    let host = crate::hosts::find(&host_id).ok_or_else(|| AbundioError::NotFound("that Host was removed".into()))?;
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut words: Vec<&str> = agents.iter().filter_map(|a| host_setup::probe_word(a)).collect();
        words.sort_unstable();
        words.dedup();
        let out = crate::remote_windows::with_ssh_mode(&app, &host.name, Some(&label), |mode| {
            host_setup::run_script(
                host.target.sh_c(mode, &host_setup::start_then_probe(restart), &words),
                "",
                STEP_LIMIT,
            )
        })
        .map_err(AbundioError::Channel)?;
        let probe = host_setup::parse_probe(&out);
        if probe.started.is_none() {
            return Err(AbundioError::Channel("the server did not start".into()));
        }
        log::info!("[host] started the server on {} ({})", host.name, probe.started.as_deref().unwrap_or(""));
        {
            use tauri::Emitter;
            let _ = app.emit(SERVER_READY_EVENT, &host_id);
        }
        let app_version = env!("CARGO_PKG_VERSION");
        Ok(HostCheck { items: host_setup::checklist(&probe, app_version), probe, app_version })
    })
    .await
    .map_err(|e| AbundioError::InvalidOperation(e.to_string()))?
}

/// Remove the server from a Host (phase 8d): stop it, drop its service,
/// delete `~/.abundio-server` with its data. The Workspace folders there
/// are never touched.
#[tauri::command]
pub async fn host_uninstall(app: AppHandle, window: Window, host_id: String) -> Result<(), AbundioError> {
    let host = crate::hosts::find(&host_id).ok_or_else(|| AbundioError::NotFound("that Host was removed".into()))?;
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let out = crate::remote_windows::with_ssh_mode(&app, &host.name, Some(&label), |mode| {
            host_setup::run_script(host.target.sh_c(mode, &host_setup::uninstall(), &[]), "", STEP_LIMIT)
        })
        .map_err(AbundioError::Channel)?;
        if !host_setup::parse_probe(&out).removed {
            return Err(AbundioError::Channel("the server was not removed".into()));
        }
        log::info!("[host] removed the server from {}", host.name);
        Ok(())
    })
    .await
    .map_err(|e| AbundioError::InvalidOperation(e.to_string()))?
}
