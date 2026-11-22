//! **Hosts** the user added (docs/plans/remote-hosts.md phase 7d): a name and
//! how to reach it, kept by the desktop app in `hosts.json` beside its data
//! (machine settings, like an ssh alias; not part of any Profile). Settings ▸
//! Hosts adds and removes them; phase 8 adds install and the checklist.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::AbundioError;
use crate::host_router::HostTarget;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEntry {
    pub id: String,
    pub name: String,
    pub target: HostTarget,
}

fn path() -> PathBuf {
    crate::app_paths::shared_root().join("hosts.json")
}

pub fn load() -> Vec<HostEntry> {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(hosts: &[HostEntry]) -> Result<(), AbundioError> {
    let p = path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(hosts).map_err(|e| AbundioError::InvalidOperation(e.to_string()))?)?;
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

pub fn find(id: &str) -> Option<HostEntry> {
    load().into_iter().find(|h| h.id == id)
}

/// Add a Host: a name, and the ssh destination or test server that reaches it.
fn add(hosts: &mut Vec<HostEntry>, name: &str, target: HostTarget) -> Result<HostEntry, AbundioError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AbundioError::InvalidOperation("a Host needs a name".into()));
    }
    if hosts.iter().any(|h| h.name.eq_ignore_ascii_case(name)) {
        return Err(AbundioError::InvalidOperation(format!("there is already a Host named {name:?}")));
    }
    if let HostTarget::Ssh { destination } = &target {
        let d = destination.trim();
        // Never a word ssh would read as an option, nor a command line.
        if d.is_empty() || d.starts_with('-') || d.chars().any(char::is_whitespace) {
            return Err(AbundioError::InvalidOperation(
                "the ssh destination must be an alias from ~/.ssh/config or user@host".into(),
            ));
        }
    }
    let entry = HostEntry { id: uuid::Uuid::new_v4().to_string(), name: name.to_string(), target };
    hosts.push(entry.clone());
    Ok(entry)
}

#[tauri::command]
pub fn hosts_list() -> Vec<HostEntry> {
    load()
}

#[tauri::command]
pub fn hosts_add(app: tauri::AppHandle, name: String, target: HostTarget) -> Result<HostEntry, AbundioError> {
    use tauri::Emitter;
    let mut hosts = load();
    let entry = add(&mut hosts, &name, target)?;
    save(&hosts)?;
    let _ = app.emit("hosts-changed", ());
    Ok(entry)
}

#[tauri::command]
pub fn hosts_remove(app: tauri::AppHandle, id: String) -> Result<(), AbundioError> {
    use tauri::Emitter;
    let mut hosts = load();
    hosts.retain(|h| h.id != id);
    save(&hosts)?;
    let _ = app.emit("hosts-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh(d: &str) -> HostTarget {
        HostTarget::Ssh { destination: d.into() }
    }

    #[test]
    fn adds_a_host_with_a_name_of_its_own_and_a_plain_destination() {
        let mut hosts = Vec::new();
        let a = add(&mut hosts, " Build box ", ssh("me@build")).unwrap();
        assert_eq!(a.name, "Build box");
        assert!(add(&mut hosts, "build BOX", ssh("x")).is_err());
        assert!(add(&mut hosts, "", ssh("x")).is_err());
        for bad in ["", "-oProxyCommand=evil", "me@box rm -rf"] {
            assert!(add(&mut hosts, "Other", ssh(bad)).is_err(), "{bad:?}");
        }
        assert_eq!(hosts.len(), 1);
    }

    #[test]
    fn reads_what_the_settings_page_sends() {
        let e: HostEntry = serde_json::from_str(
            r#"{"id":"1","name":"Box","target":{"kind":"ssh","destination":"me@box"}}"#,
        )
        .unwrap();
        assert_eq!(e.target, ssh("me@box"));
    }
}
