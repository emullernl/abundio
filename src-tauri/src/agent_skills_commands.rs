//! The Tauri commands of **Skill provisioning** (ADR-0054); what they do is
//! in the core crate (`abundio_core::agent_skills`), so a Host writes the
//! skill the same way.

use std::io;

use crate::agent_skills::{provision_at, status_at, SkillEntryStatus, SkillPaths, SkillStartupGuard};
use crate::error::AbundioError;

fn blocking_err(e: impl std::fmt::Display) -> AbundioError {
    AbundioError::Io(io::Error::other(e.to_string()))
}

/// Re-sync the skill after a settings change.
#[tauri::command]
pub async fn agent_skill_provision(
    enabled: bool,
    enabled_agents: Vec<String>,
) -> Result<(), AbundioError> {
    tauri::async_runtime::spawn_blocking(move || {
        provision_at(&SkillPaths::for_user()?, enabled, &enabled_agents)
    })
    .await
    .map_err(blocking_err)?
}

/// At startup, once per process however many Windows ask: rewrite the skill
/// so an upgrade brings its new text.
#[tauri::command]
pub async fn agent_skill_provision_startup(
    enabled: bool,
    enabled_agents: Vec<String>,
    guard: tauri::State<'_, SkillStartupGuard>,
) -> Result<(), AbundioError> {
    if !guard.claim() {
        return Ok(());
    }
    eprintln!("[abundio] startup skill provisioning: enabled={enabled}");
    tauri::async_runtime::spawn_blocking(move || {
        let result = provision_at(&SkillPaths::for_user()?, enabled, &enabled_agents);
        if let Err(e) = &result {
            eprintln!("[abundio] startup skill provisioning: {e}");
        }
        result
    })
    .await
    .map_err(blocking_err)?
}

/// Where the skill is, for Settings.
#[tauri::command]
pub async fn agent_skill_status() -> Result<Vec<SkillEntryStatus>, AbundioError> {
    tauri::async_runtime::spawn_blocking(|| Ok(status_at(&SkillPaths::for_user()?)))
        .await
        .map_err(blocking_err)?
}

