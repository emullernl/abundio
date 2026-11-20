//! Host setup's commands (docs/plans/remote-hosts.md phase 8): Settings ▸
//! Hosts asks what a Host has (`host_check`), and installs, starts, updates
//! or removes the server there. Each is a short `ssh` of its own; SSH
//! prompts show in the Window that asked.

use std::time::Duration;

use abundio_core::host_setup::{self, CheckItem, Probe};
use serde::Serialize;
use tauri::{AppHandle, Window};

use crate::error::AbundioError;

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
        Ok(HostCheck { items: host_setup::checklist(&probe, app_version), probe, app_version })
    })
    .await
    .map_err(|e| AbundioError::InvalidOperation(e.to_string()))?
}
