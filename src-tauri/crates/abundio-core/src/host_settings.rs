//! **Host settings** (ADR-0064, `GLOSSARY.md`): the settings that describe
//! a machine, kept in that Host's own database, this computer included: its
//! Agent list (each built-in's switch, its custom Agents), whether Abundio
//! writes its hooks and skill into the Agents there, its default shell and
//! its terminal scrollback. Agent control's switch is a Host setting too,
//! kept under its own key (`control_protocol::SETTING_KEY`).
//!
//! One JSON record under one key of the `settings` table. The built-in
//! Agents' definitions stay in the app's code (`agents.ts`); a Host keeps only
//! which of them are on. Custom Agents are kept whole, as the app shapes them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AbundioError;
use crate::workspace_store::WorkspaceStore;

/// The `settings` key the record is kept under.
pub const KEY: &str = "host_settings";

/// Told to every Client when a Host's settings change.
pub const CHANGED_EVENT: &str = "host-settings-changed";

/// The built-in Agents, by id, which is also each one's command
/// (`BUILTIN_AGENTS` in `agents.ts`; a test holds the two equal).
pub const BUILTIN_AGENT_IDS: &[&str] = &[
    "claude", "copilot", "gemini", "codex", "opencode", "qwen", "kimi", "grok", "vibe",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSettings {
    /// Built-in Agent id → whether it is on here. A built-in not listed is
    /// off.
    #[serde(default)]
    pub agent_switches: BTreeMap<String, bool>,
    /// Custom Agents, as the app shapes them (`CodingAgent`).
    #[serde(default)]
    pub custom_agents: Vec<Value>,
    #[serde(default = "yes")]
    pub agent_hooks_enabled: bool,
    #[serde(default = "yes")]
    pub agent_skill_enabled: bool,
    /// The shell a new pane starts; `None`: the user's login shell.
    #[serde(default)]
    pub shell_path: Option<String>,
    /// Lines of scrollback each pane keeps; `None`: the app's default.
    #[serde(default)]
    pub scrollback: Option<usize>,
}

fn yes() -> bool {
    true
}

impl HostSettings {
    /// A new Host's settings: the built-in Agents installed there on.
    pub fn from_installed(installed: impl Fn(&str) -> bool) -> Self {
        HostSettings {
            agent_switches: BUILTIN_AGENT_IDS.iter().map(|id| (id.to_string(), installed(id))).collect(),
            custom_agents: Vec::new(),
            agent_hooks_enabled: true,
            agent_skill_enabled: true,
            shell_path: None,
            scrollback: None,
        }
    }

    /// The commands a typed line starts an Agent with, for this Host's shell
    /// integration (`shell_integration::AgentCommands`): its built-ins with
    /// their switches, then its custom Agents.
    pub fn agent_commands(&self) -> Vec<crate::shell_integration::AgentCommand> {
        let builtins = BUILTIN_AGENT_IDS.iter().map(|id| crate::shell_integration::AgentCommand {
            id: id.to_string(),
            command: id.to_string(),
            enabled: self.agent_switches.get(*id).copied().unwrap_or(false),
        });
        let custom = self.custom_agents.iter().filter_map(|a| {
            Some(crate::shell_integration::AgentCommand {
                id: a.get("id")?.as_str()?.to_string(),
                command: a.get("command")?.as_str()?.to_string(),
                enabled: a.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            })
        });
        builtins.chain(custom).collect()
    }

    /// The built-in Agents switched on, for hooks and skill provisioning.
    pub fn enabled_builtins(&self) -> Vec<String> {
        BUILTIN_AGENT_IDS
            .iter()
            .filter(|id| self.agent_switches.get(**id).copied().unwrap_or(false))
            .map(|id| id.to_string())
            .collect()
    }
}

/// This Host's settings, or `None` before they were ever written (this
/// computer before its values moved here from the app's browser storage).
pub fn get(store: &WorkspaceStore) -> Result<Option<HostSettings>, AbundioError> {
    match store.get_setting(KEY)? {
        Some(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| AbundioError::InvalidOperation(format!("the Host settings cannot be read: {e}"))),
        None => Ok(None),
    }
}

pub fn set(store: &WorkspaceStore, settings: &HostSettings) -> Result<(), AbundioError> {
    let json = serde_json::to_string(settings).map_err(|e| AbundioError::InvalidOperation(e.to_string()))?;
    store.set_setting(KEY, &json)
}

/// A server's first start: its settings, written from what is installed
/// there if it has none yet. `installed` looks a command up on the Host's
/// login-shell PATH.
pub fn ensure_seeded(store: &WorkspaceStore, installed: impl Fn(&str) -> bool) -> Result<HostSettings, AbundioError> {
    if let Some(s) = get(store)? {
        return Ok(s);
    }
    let seeded = HostSettings::from_installed(installed);
    set(store, &seeded)?;
    log::info!("Host settings seeded: Agents on: {:?}", seeded.enabled_builtins());
    Ok(seeded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> WorkspaceStore {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        WorkspaceStore::new(conn)
    }

    #[test]
    fn a_new_host_switches_on_the_built_ins_installed_there_once() {
        let s = store();
        assert_eq!(get(&s).unwrap(), None);
        let seeded = ensure_seeded(&s, |cmd| ["claude", "opencode"].contains(&cmd)).unwrap();
        assert_eq!(seeded.enabled_builtins(), ["claude", "opencode"]);
        assert!(seeded.agent_hooks_enabled && seeded.agent_skill_enabled);
        // Seeded once: what the user changes afterwards stays.
        let mut changed = seeded.clone();
        changed.agent_switches.insert("claude".into(), false);
        set(&s, &changed).unwrap();
        let again = ensure_seeded(&s, |_| true).unwrap();
        assert_eq!(again.enabled_builtins(), ["opencode"]);
    }

    #[test]
    fn a_hosts_agent_commands_are_its_switches_and_custom_agents() {
        let mut s = HostSettings::from_installed(|c| c == "opencode");
        s.custom_agents.push(serde_json::json!({ "id": "mine", "name": "Mine", "command": "my-agent", "enabled": true }));
        s.custom_agents.push(serde_json::json!({ "broken": true }));
        let cmds = s.agent_commands();
        let on: Vec<&str> = cmds.iter().filter(|c| c.enabled).map(|c| c.command.as_str()).collect();
        assert_eq!(on, ["opencode", "my-agent"]);
        assert_eq!(cmds.len(), BUILTIN_AGENT_IDS.len() + 1);
    }

    #[test]
    fn reads_a_record_missing_newer_fields_with_their_defaults() {
        let s = store();
        s.set_setting(KEY, r#"{"agentSwitches":{"codex":true}}"#).unwrap();
        let read = get(&s).unwrap().unwrap();
        assert_eq!(read.enabled_builtins(), ["codex"]);
        assert!(read.agent_hooks_enabled);
        assert_eq!((read.shell_path, read.scrollback), (None, None));
    }

    /// The built-ins Rust knows are the app's (`agents.ts`), and each one's
    /// id is its command, which the seeding looks up.
    #[test]
    fn knows_the_apps_built_in_agents() {
        let ts = include_str!("../../../../src/lib/agents.ts");
        let block = ts.split("export const BUILTIN_AGENTS").nth(1).unwrap().split("\n];").next().unwrap();
        let field = |name: &str| -> Vec<String> {
            block
                .lines()
                .filter_map(|l| l.trim().strip_prefix(&format!("{name}: \"")))
                .map(|rest| rest.split('"').next().unwrap().to_string())
                .collect()
        };
        assert_eq!(field("id"), BUILTIN_AGENT_IDS);
        assert_eq!(field("command"), BUILTIN_AGENT_IDS);
    }
}
