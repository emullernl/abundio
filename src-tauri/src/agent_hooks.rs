//! Provisioning of Agent status hooks.
//!
//! When the user enables "Agent status hooks", Abundio registers a hook in each
//! installed Agent's config so the Agent runs the `abundio-hook` relay on its
//! lifecycle events. The relay POSTs to the loopback `hook_server`.
//!
//! See `docs/adr/0003-agent-hooks-provisioned-globally.md`. Provisioning is
//! global (per-user config dirs), idempotent, and removes only Abundio's own
//! entries on disable. Agents with a standalone hooks file get an Abundio-owned
//! file (deleted on disable); Claude and Gemini/Qwen have no separate hooks
//! file, so their entries are merged into `settings.json` and identified by the
//! relay-script path in the hook `command`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::AbundioError;

/// One-shot guard so startup provisioning runs a single time per process,
/// however many Windows call into it. Managed in `lib.rs` and read by the
/// `agent_hooks_provision_startup` command. See ADR-0003 (Revisited).
#[derive(Default)]
pub struct StartupProvisionGuard(AtomicBool);

impl StartupProvisionGuard {
    /// Returns true exactly once — on the first call this process. Subsequent
    /// calls (e.g. from other Windows' rehydrate) return false.
    pub fn claim(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }
}

const RELAY_SH: &str = r#"#!/bin/sh
# Abundio agent status hook relay — auto-generated, do not edit.
# Pure observer: always exits 0 with empty-JSON stdout, never influences the
# agent. No-op when not running inside Abundio.
if [ -z "$ABUNDIO_PTY_ID" ] || [ -z "$ABUNDIO_HOOK_PORT" ]; then
  printf '{}'
  exit 0
fi
curl -s -m 2 -X POST \
  -H "X-Abundio-Token: ${ABUNDIO_HOOK_TOKEN}" \
  -H "X-Abundio-Workspace: ${ABUNDIO_WORKSPACE_NAME}" \
  -H "X-Abundio-Window-Label: ${ABUNDIO_WINDOW_LABEL}" \
  --data-binary @- \
  "http://127.0.0.1:${ABUNDIO_HOOK_PORT}/hook?event=$1&agent=$2&pty=${ABUNDIO_PTY_ID}" \
  >/dev/null 2>&1 || true
printf '{}'
exit 0
"#;

const RELAY_PS1: &str = r#"# Abundio agent status hook relay (PowerShell) — auto-generated, do not edit.
# Pure observer: always exits 0 with empty-JSON stdout. No-op outside Abundio.
if (-not $env:ABUNDIO_PTY_ID -or -not $env:ABUNDIO_HOOK_PORT) { '{}'; exit 0 }
$body = [Console]::In.ReadToEnd()
$uri = "http://127.0.0.1:$($env:ABUNDIO_HOOK_PORT)/hook?event=$($args[0])&agent=$($args[1])&pty=$($env:ABUNDIO_PTY_ID)"
try {
  Invoke-RestMethod -Uri $uri -Method Post -Body $body -TimeoutSec 2 `
    -Headers @{
      "X-Abundio-Token" = "$($env:ABUNDIO_HOOK_TOKEN)"
      "X-Abundio-Workspace" = "$($env:ABUNDIO_WORKSPACE_NAME)"
      "X-Abundio-Window-Label" = "$($env:ABUNDIO_WINDOW_LABEL)"
    } | Out-Null
} catch { }
'{}'
exit 0
"#;

/// Resolved relay script paths for both shells.
struct RelayPaths {
    sh: PathBuf,
    ps1: PathBuf,
}

impl RelayPaths {
    /// The relay script for the current platform.
    fn primary(&self) -> &Path {
        #[cfg(windows)]
        {
            &self.ps1
        }
        #[cfg(not(windows))]
        {
            &self.sh
        }
    }
}

fn io_err(msg: String) -> AbundioError {
    AbundioError::Io(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        msg,
    ))
}

/// Directory holding the relay scripts (inside Abundio's own data dir).
fn relay_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("abundio")
        .join("hooks")
}

/// Compute the relay script paths without writing them. Used by the read-only
/// inspection paths (`config_state`, `agent_hook_status`) which must not have
/// the side effect of (re)writing the scripts.
fn relay_paths() -> RelayPaths {
    let dir = relay_dir();
    RelayPaths {
        sh: dir.join("abundio-hook.sh"),
        ps1: dir.join("abundio-hook.ps1"),
    }
}

/// Refresh the relay scripts on disk to match this binary's `RELAY_SH` /
/// `RELAY_PS1`. Safe to call unconditionally on startup — the scripts are
/// pure functions of the binary, contain no user data, and overwriting them
/// is the only way to roll out a relay change without making users toggle
/// the setting off and on. Does **not** touch user-config hook entries —
/// those stay driven by `provision()` (the toggle path).
pub fn refresh_relay_scripts() -> Result<(), AbundioError> {
    write_relay_scripts().map(|_| ())
}

/// Write both relay scripts; make the shell script executable on Unix.
fn write_relay_scripts() -> Result<RelayPaths, AbundioError> {
    let paths = relay_paths();
    fs::create_dir_all(relay_dir())?;
    fs::write(&paths.sh, RELAY_SH)?;
    fs::write(&paths.ps1, RELAY_PS1)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&paths.sh, fs::Permissions::from_mode(0o755))?;
    }
    Ok(paths)
}

fn write_atomic(path: &Path, content: &str) -> Result<(), AbundioError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("abundio-tmp");
    // fsync before rename: without this, a power loss between rename and the
    // kernel's page flush can leave the published file empty or partial,
    // which the next launch sees as unparseable and aborts on. Cost is one
    // fsync per provision (only on toggle changes).
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Hook command string for a command-hook agent (Claude / Gemini / Codex).
fn command_str(relay: &Path, event: &str, agent: &str) -> String {
    let p = relay.to_string_lossy();
    #[cfg(windows)]
    {
        format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\" {} {}",
            p, event, agent
        )
    }
    #[cfg(not(windows))]
    {
        format!("sh \"{}\" {} {}", p, event, agent)
    }
}

/// A single Claude/Gemini-style hook matcher group `{ matcher?, hooks: [...] }`.
fn make_group(matcher: Option<&str>, command: &str, async_hook: bool) -> Value {
    let mut handler = json!({ "type": "command", "command": command });
    if async_hook {
        handler["async"] = json!(true);
    }
    let mut group = json!({ "hooks": [handler] });
    if let Some(m) = matcher {
        group["matcher"] = json!(m);
    }
    group
}

/// True when a matcher group was installed by Abundio (a handler whose
/// `command` references the relay script).
fn group_is_abundio(group: &Value, relay_marker: &str) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|handlers| {
            handlers.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(relay_marker))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Events to register for a `settings.json`-merge agent: (event, matcher, async).
fn merge_agent_events(agent: &str) -> Vec<(&'static str, Option<&'static str>, bool)> {
    match agent {
        "claude" => vec![
            ("UserPromptSubmit", None, true),
            ("PermissionRequest", None, true),
            ("Stop", None, true),
            ("StopFailure", None, true),
            ("SessionEnd", None, true),
        ],
        // Gemini / Qwen: `Notification` is their only permission signal. We
        // register it without a matcher (the exact tool-permission matcher
        // token is undocumented; a wrong matcher would fire never). Non-
        // permission notifications also flipping to "waiting" is an accepted
        // limitation.
        "gemini" | "qwen" => vec![
            ("BeforeAgent", None, false),
            ("AfterAgent", None, false),
            ("Notification", None, false),
            ("SessionEnd", None, false),
        ],
        _ => vec![],
    }
}

/// Merge (or strip) Abundio's hook entries in a co-owned `settings.json`.
fn provision_merge_settings(
    path: &Path,
    enabled: bool,
    agent: &str,
    relay: &Path,
) -> Result<(), AbundioError> {
    let relay_marker = relay.to_string_lossy().into_owned();

    let mut root: Value = if path.exists() {
        let text = fs::read_to_string(path)?;
        if text.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&text).map_err(|e| {
                io_err(format!(
                    "{} is not valid JSON ({}) — skipped hook provisioning",
                    path.display(),
                    e
                ))
            })?
        }
    } else if enabled {
        json!({})
    } else {
        return Ok(()); // nothing to strip
    };

    let obj = root
        .as_object_mut()
        .ok_or_else(|| io_err(format!("{} is not a JSON object", path.display())))?;

    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    let hooks_obj = hooks
        .as_object_mut()
        .ok_or_else(|| io_err(format!("{} has a non-object `hooks` key", path.display())))?;

    // Always strip prior Abundio entries first — idempotent, and the disable path.
    for value in hooks_obj.values_mut() {
        if let Some(arr) = value.as_array_mut() {
            arr.retain(|group| !group_is_abundio(group, &relay_marker));
        }
    }

    if enabled {
        for (event, matcher, async_hook) in merge_agent_events(agent) {
            let cmd = command_str(relay, event, agent);
            let group = make_group(matcher, &cmd, async_hook);
            if let Some(arr) = hooks_obj
                .entry(event)
                .or_insert_with(|| json!([]))
                .as_array_mut()
            {
                arr.push(group);
            }
        }
    }

    // Tidy: drop emptied event arrays and an emptied `hooks` object.
    hooks_obj.retain(|_, v| v.as_array().map(|a| !a.is_empty()).unwrap_or(true));
    if hooks_obj.is_empty() {
        obj.remove("hooks");
    }

    let serialized =
        serde_json::to_string_pretty(&root).map_err(|e| io_err(e.to_string()))?;
    write_atomic(path, &serialized)?;
    Ok(())
}

/// Write or delete an Abundio-owned config file.
fn provision_own_file(path: &Path, enabled: bool, content: &str) -> Result<(), AbundioError> {
    if enabled {
        write_atomic(path, content)?;
    } else if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

/// Codex `hooks.json` (Abundio-owned). Same matcher-group shape as Claude.
fn codex_config(relay: &Path) -> Result<String, AbundioError> {
    let mut hooks = serde_json::Map::new();
    for event in ["UserPromptSubmit", "PermissionRequest", "Stop"] {
        let cmd = command_str(relay, event, "codex");
        hooks.insert(event.to_string(), json!([make_group(None, &cmd, false)]));
    }
    serde_json::to_string_pretty(&json!({ "hooks": hooks }))
        .map_err(|e| io_err(e.to_string()))
}

/// Copilot CLI hook file (Abundio-owned). Copilot wants `bash` + `powershell`
/// keys on the command rather than a single `command`, and supports an optional
/// `matcher` regex on a hook entry — tested against `notification_type` for
/// `notification`, against `toolName` for tool hooks, and anchored as
/// `^(?:pattern)$` by Copilot.
///
/// Waiting is driven by `notification` scoped to `permission_prompt` (the only
/// notification that means a genuine permission block), not the noisy
/// `permissionRequest` (which fired per permission-gated tool even on autopilot
/// and needed a 1500ms debounce). `preToolUse` is kept *only* for the two tools
/// whose execution IS a prompt blocking on the user — `exit_plan_mode` and
/// `ask_user`, which emit no `notification` — matcher-scoped so it no longer
/// fires per tool. See ADR-0015.
fn copilot_config(relay: &RelayPaths) -> Result<String, AbundioError> {
    let bash = |event: &str| format!("sh \"{}\" {} copilot", relay.sh.to_string_lossy(), event);
    let powershell = |event: &str| {
        format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\" {} copilot",
            relay.ps1.to_string_lossy(),
            event
        )
    };
    let mut hooks = serde_json::Map::new();
    // (event, optional matcher). The matcher is the raw pattern; Copilot anchors
    // it `^(?:pattern)$`.
    for (event, matcher) in [
        ("userPromptSubmitted", None),
        ("preToolUse", Some("exit_plan_mode|ask_user")),
        ("notification", Some("permission_prompt")),
        ("agentStop", None),
        ("errorOccurred", None),
        ("sessionEnd", None),
    ] {
        let mut entry = json!({
            "type": "command",
            "bash": bash(event),
            "powershell": powershell(event),
            "timeoutSec": 5,
        });
        if let Some(m) = matcher {
            entry["matcher"] = json!(m);
        }
        hooks.insert(event.to_string(), json!([entry]));
    }
    serde_json::to_string_pretty(&json!({ "version": 1, "hooks": hooks }))
        .map_err(|e| io_err(e.to_string()))
}

/// OpenCode plugin source (Abundio-owned). Forwards lifecycle events directly
/// to the loopback server — OpenCode plugins are JS, so no relay is needed.
fn opencode_plugin() -> String {
    r#"// Abundio agent status hook plugin — auto-generated, do not edit.
// Forwards OpenCode lifecycle events to Abundio's loopback status server.
export const AbundioStatus = async () => {
  const post = (event) => {
    const pty = process.env.ABUNDIO_PTY_ID;
    const port = process.env.ABUNDIO_HOOK_PORT;
    const token = process.env.ABUNDIO_HOOK_TOKEN;
    if (!pty || !port || !event) return;
    fetch(
      `http://127.0.0.1:${port}/hook?event=${encodeURIComponent(event)}` +
        `&agent=opencode&pty=${encodeURIComponent(pty)}`,
      { method: "POST", headers: { "X-Abundio-Token": token ?? "" }, body: "{}" },
    ).catch(() => {});
  };
  return {
    event: async ({ event }) => {
      post(event && event.type);
    },
  };
};
"#
    .to_string()
}

/// True when a callable `curl` is on PATH. The Unix relay script POSTs via
/// curl; without it the script silently no-ops (`|| true`), so the user gets
/// "hooks installed but never fire" with no diagnostic. Several minimal Linux
/// installs (Debian/Ubuntu minimal, Alpine, base Arch) ship without it.
#[cfg(not(windows))]
fn curl_available() -> bool {
    Command::new("sh")
        .args(["-c", "command -v curl >/dev/null 2>&1"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The agents Abundio can provision hooks for, in display order. Aider and
/// custom user agents are intentionally absent — Abundio has no hook
/// integration for them.
const SUPPORTED_AGENTS: &[&str] = &["claude", "gemini", "qwen", "codex", "copilot", "opencode"];

/// Whether Abundio merges entries into a config the agent also owns, or owns
/// the whole file itself.
#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Ownership {
    /// Entries merged into a file the agent also writes (e.g. `settings.json`).
    Merged,
    /// A file Abundio writes wholesale and deletes on disable.
    Owned,
}

/// Static provisioning facts for one supported agent.
struct AgentDescriptor {
    /// Config dir, relative to `$HOME`, whose existence gates startup provisioning.
    dir_rel: PathBuf,
    /// Config file Abundio touches, relative to `$HOME`.
    config_rel: PathBuf,
    ownership: Ownership,
    /// Lifecycle events Abundio hooks (for the Settings footprint display).
    events: Vec<String>,
}

/// Resolve an agent id to its provisioning descriptor, or `None` when Abundio
/// has no hook integration for it (Aider, custom user agents).
fn agent_descriptor(agent_id: &str) -> Option<AgentDescriptor> {
    let merge_events = |a: &str| {
        merge_agent_events(a)
            .into_iter()
            .map(|(e, _, _)| e.to_string())
            .collect::<Vec<_>>()
    };
    let owned_events = |events: &[&str]| events.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match agent_id {
        "claude" => Some(AgentDescriptor {
            dir_rel: PathBuf::from(".claude"),
            config_rel: [".claude", "settings.json"].iter().collect(),
            ownership: Ownership::Merged,
            events: merge_events("claude"),
        }),
        "gemini" => Some(AgentDescriptor {
            dir_rel: PathBuf::from(".gemini"),
            config_rel: [".gemini", "settings.json"].iter().collect(),
            ownership: Ownership::Merged,
            events: merge_events("gemini"),
        }),
        "qwen" => Some(AgentDescriptor {
            dir_rel: PathBuf::from(".qwen"),
            config_rel: [".qwen", "settings.json"].iter().collect(),
            ownership: Ownership::Merged,
            events: merge_events("qwen"),
        }),
        "codex" => Some(AgentDescriptor {
            dir_rel: PathBuf::from(".codex"),
            config_rel: [".codex", "hooks.json"].iter().collect(),
            ownership: Ownership::Owned,
            events: owned_events(&["UserPromptSubmit", "PermissionRequest", "Stop"]),
        }),
        "copilot" => Some(AgentDescriptor {
            dir_rel: PathBuf::from(".copilot"),
            config_rel: [".copilot", "hooks", "abundio.json"].iter().collect(),
            ownership: Ownership::Owned,
            events: owned_events(&[
                "userPromptSubmitted",
                "preToolUse",
                "notification",
                "agentStop",
                "errorOccurred",
                "sessionEnd",
            ]),
        }),
        "opencode" => Some(AgentDescriptor {
            dir_rel: [".config", "opencode"].iter().collect(),
            config_rel: [".config", "opencode", "plugin", "abundio.ts"]
                .iter()
                .collect(),
            ownership: Ownership::Owned,
            events: vec!["all lifecycle events".to_string()],
        }),
        _ => None,
    }
}

/// Content for an Abundio-owned config file. Errors only on serialization
/// failure (effectively never).
fn owned_content(agent_id: &str, relay: &RelayPaths) -> Result<String, AbundioError> {
    match agent_id {
        "codex" => codex_config(relay.primary()),
        "copilot" => copilot_config(relay),
        "opencode" => Ok(opencode_plugin()),
        _ => Ok(String::new()),
    }
}

/// Provision (or strip) hooks for a single agent.
///
/// `create_dir` lets the launch path scaffold a missing config dir so a
/// freshly-installed agent gets hooks on its very first run; startup/toggle
/// pass `false` to honor ADR-0003's no-litter rule (skip agents that have no
/// config dir yet). Unsupported agents are a no-op.
fn provision_agent(
    home: &Path,
    relay: &RelayPaths,
    agent_id: &str,
    enabled: bool,
    create_dir: bool,
) -> Result<(), AbundioError> {
    let Some(desc) = agent_descriptor(agent_id) else {
        return Ok(());
    };
    let dir = home.join(&desc.dir_rel);
    if !dir.is_dir() {
        if enabled && create_dir {
            fs::create_dir_all(&dir)?;
        } else {
            // No dir: nothing to strip on disable, and don't litter on enable.
            return Ok(());
        }
    }
    let path = home.join(&desc.config_rel);
    match desc.ownership {
        Ownership::Merged => provision_merge_settings(&path, enabled, agent_id, relay.primary()),
        Ownership::Owned => {
            if enabled {
                let content = owned_content(agent_id, relay)?;
                provision_own_file(&path, true, &content)
            } else {
                provision_own_file(&path, false, "")
            }
        }
    }
}

/// True when Abundio's relay marker is present anywhere in a parsed merge config.
fn merge_has_marker(root: &Value, marker: &str) -> bool {
    root.get("hooks")
        .and_then(|h| h.as_object())
        .map(|hooks| {
            hooks.values().any(|v| {
                v.as_array()
                    .map(|arr| arr.iter().any(|g| group_is_abundio(g, marker)))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Per-agent registration state derived purely from on-disk config.
#[derive(Clone, Copy, PartialEq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
enum HookConfigState {
    /// Abundio's entries are present.
    Registered,
    /// Supported, but Abundio's entries are absent (incl. no config dir/file).
    NotRegistered,
    /// A merge config exists but is unparseable — Abundio won't touch it.
    ConfigError,
}

/// Inspect one agent's config (no writes) and classify it.
fn config_state(home: &Path, relay: &RelayPaths, agent_id: &str) -> HookConfigState {
    let Some(desc) = agent_descriptor(agent_id) else {
        return HookConfigState::NotRegistered;
    };
    let path = home.join(&desc.config_rel);
    match desc.ownership {
        Ownership::Merged => {
            let text = match fs::read_to_string(&path) {
                Ok(t) => t,
                Err(_) => return HookConfigState::NotRegistered, // file absent
            };
            if text.trim().is_empty() {
                return HookConfigState::NotRegistered;
            }
            match serde_json::from_str::<Value>(&text) {
                Err(_) => HookConfigState::ConfigError,
                Ok(root) => {
                    let marker = relay.primary().to_string_lossy();
                    if merge_has_marker(&root, &marker) {
                        HookConfigState::Registered
                    } else {
                        HookConfigState::NotRegistered
                    }
                }
            }
        }
        // Abundio owns the whole file — its presence means registered.
        Ownership::Owned => {
            if path.exists() {
                HookConfigState::Registered
            } else {
                HookConfigState::NotRegistered
            }
        }
    }
}

/// True when this agent's hooks are currently provisioned on disk.
fn is_provisioned(home: &Path, relay: &RelayPaths, agent_id: &str) -> bool {
    config_state(home, relay, agent_id) == HookConfigState::Registered
}

/// Read-only provisioning footprint for one supported agent, for Settings.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookStatus {
    agent_id: String,
    config_path: String,
    ownership: Ownership,
    events: Vec<String>,
    state: HookConfigState,
}

/// Inspect every supported agent's config and report its footprint. Pure read —
/// never writes relay scripts or config files. Aider / custom agents are absent
/// from the result; the frontend renders those as "not supported".
pub fn agent_hook_status() -> Result<Vec<AgentHookStatus>, AbundioError> {
    let home = dirs::home_dir().ok_or_else(|| io_err("no home directory".into()))?;
    let relay = relay_paths();
    Ok(SUPPORTED_AGENTS
        .iter()
        .filter_map(|&agent_id| {
            let desc = agent_descriptor(agent_id)?;
            Some(AgentHookStatus {
                agent_id: agent_id.to_string(),
                config_path: home.join(&desc.config_rel).to_string_lossy().into_owned(),
                ownership: desc.ownership,
                events: desc.events,
                state: config_state(&home, &relay, agent_id),
            })
        })
        .collect())
}

/// Register hooks for a single agent on demand if they aren't already, creating
/// the agent's config dir if absent. Called when an agent is launched so a
/// mid-session install gets hooks without restarting Abundio. No-op when hooks
/// are disabled, the agent is unsupported, or it's already provisioned. Returns
/// whether it actually provisioned.
pub fn ensure_agent_hooks(agent_id: &str, enabled: bool) -> Result<bool, AbundioError> {
    if !enabled || agent_descriptor(agent_id).is_none() {
        return Ok(false);
    }
    let home = dirs::home_dir().ok_or_else(|| io_err("no home directory".into()))?;
    // Ensure the relay scripts exist before any config references them.
    let relay = write_relay_scripts()?;
    if is_provisioned(&home, &relay, agent_id) {
        return Ok(false);
    }
    provision_agent(&home, &relay, agent_id, true, true)?;
    Ok(true)
}

/// Enable or disable Agent status hooks across every supported Agent.
///
/// Provisioning is gated per-agent: an Agent gets hooks only when `enabled` (the
/// global Status Hooks setting) is true AND its id is in `enabled_agents` (its
/// own detection toggle). Every supported Agent not meeting both is stripped, so
/// this also serves as the "an agent was toggled off" path. When `enabled` is
/// false, all are stripped regardless of `enabled_agents`.
///
/// Per-agent failures are collected and reported but do not abort the rest —
/// a corrupt `~/.claude/settings.json` must not prevent provisioning Codex.
/// Startup and toggle both route here; neither scaffolds a missing config dir.
pub fn provision(enabled: bool, enabled_agents: &[String]) -> Result<(), AbundioError> {
    let home = dirs::home_dir().ok_or_else(|| io_err("no home directory".into()))?;
    let relay = write_relay_scripts()?;
    let mut errors: Vec<String> = Vec::new();

    // Surface the missing-curl case once, up front, only when actually enabling.
    // Disable still runs so stale entries get cleaned up even on a system where
    // curl was uninstalled after provisioning.
    #[cfg(not(windows))]
    if enabled && !curl_available() {
        errors.push(
            "`curl` was not found on PATH — Agent status hooks were registered \
             but won't fire. Install curl (e.g. `apt install curl`) and toggle \
             the setting off and on again."
                .to_string(),
        );
    }

    for &agent_id in SUPPORTED_AGENTS {
        let agent_on = enabled && enabled_agents.iter().any(|a| a == agent_id);
        if let Err(e) = provision_agent(&home, &relay, agent_id, agent_on, false) {
            errors.push(e.to_string());
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(io_err(errors.join("; ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn relay() -> PathBuf {
        PathBuf::from("/tmp/abundio/hooks/abundio-hook.sh")
    }

    #[test]
    fn merge_adds_then_strips_idempotently() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"theme":"dark","hooks":{"Stop":[{"hooks":[{"type":"command","command":"my-own-hook"}]}]}}"#).unwrap();

        // Enable twice — must not duplicate Abundio entries.
        provision_merge_settings(&path, true, "claude", &relay()).unwrap();
        provision_merge_settings(&path, true, "claude", &relay()).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();

        // The user's own key and own Stop hook are preserved.
        assert_eq!(v["theme"], "dark");
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert!(stop.iter().any(|g| group_is_abundio(g, "abundio-hook.sh")));
        let abundio_count = stop
            .iter()
            .filter(|g| group_is_abundio(g, "abundio-hook.sh"))
            .count();
        assert_eq!(abundio_count, 1, "re-provisioning must not duplicate");
        assert_eq!(stop.len(), 2, "user's own Stop hook must survive");

        // Disable — Abundio entries gone, user's key + own hook intact.
        provision_merge_settings(&path, false, "claude", &relay()).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["theme"], "dark");
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1);
        assert!(!group_is_abundio(&stop[0], "abundio-hook.sh"));
    }

    #[test]
    fn merge_aborts_on_unparseable_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{ this is not json").unwrap();
        let result = provision_merge_settings(&path, true, "claude", &relay());
        assert!(result.is_err());
        // The corrupt file must be left untouched.
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ this is not json");
    }

    #[test]
    fn copilot_config_drives_waiting_from_notification() {
        let dir = tempfile::tempdir().unwrap();
        let relay = RelayPaths {
            sh: dir.path().join("abundio-hook.sh"),
            ps1: dir.path().join("abundio-hook.ps1"),
        };
        let v: Value = serde_json::from_str(&copilot_config(&relay).unwrap()).unwrap();
        let hooks = v["hooks"].as_object().unwrap();

        // notification is the permission-block signal, scoped to permission_prompt.
        let notif = hooks["notification"].as_array().unwrap();
        assert_eq!(notif[0]["matcher"], "permission_prompt");
        assert!(notif[0]["bash"]
            .as_str()
            .unwrap()
            .contains("notification copilot"));

        // preToolUse survives only for the two prompt-tools, matcher-scoped so it
        // no longer fires per tool.
        let pre = hooks["preToolUse"].as_array().unwrap();
        assert_eq!(pre[0]["matcher"], "exit_plan_mode|ask_user");

        // The noisy per-tool hooks are gone — Waiting no longer comes from them
        // (see ADR-0015).
        assert!(!hooks.contains_key("permissionRequest"));
        assert!(!hooks.contains_key("postToolUse"));
        assert!(!hooks.contains_key("postToolUseFailure"));

        // Unscoped lifecycle hooks carry no matcher.
        assert!(hooks["userPromptSubmitted"][0].get("matcher").is_none());
        assert!(hooks["agentStop"][0].get("matcher").is_none());
    }

    #[test]
    fn copilot_matchers_anchor_to_exactly_the_intended_values() {
        // Copilot wraps a hook's `matcher` as `^(?:pattern)$`. Mirror that here so
        // a future typo in a matcher string (or a pattern that doesn't anchor
        // cleanly) fails at test time rather than silently matching nothing — the
        // "fire-never" risk called out in ADR-0015's alternatives.
        let dir = tempfile::tempdir().unwrap();
        let relay = RelayPaths {
            sh: dir.path().join("abundio-hook.sh"),
            ps1: dir.path().join("abundio-hook.ps1"),
        };
        let v: Value = serde_json::from_str(&copilot_config(&relay).unwrap()).unwrap();

        let anchored = |event: &str| -> regex::Regex {
            let m = v["hooks"][event][0]["matcher"].as_str().unwrap();
            regex::Regex::new(&format!("^(?:{m})$")).expect("matcher must compile")
        };

        // notification fires only for the genuine permission prompt — not a
        // renamed/suffixed look-alike.
        let notif = anchored("notification");
        assert!(notif.is_match("permission_prompt"));
        assert!(!notif.is_match("permission_prompt_legacy"));
        assert!(!notif.is_match("xpermission_prompt"));
        assert!(!notif.is_match("permission"));

        // preToolUse fires only for the two prompt-tools, not their look-alikes —
        // proves the unanchored alternation still binds to whole tool names.
        let pre = anchored("preToolUse");
        assert!(pre.is_match("exit_plan_mode"));
        assert!(pre.is_match("ask_user"));
        assert!(!pre.is_match("ask_user_confirm"));
        assert!(!pre.is_match("exit_plan_mode_v2"));
        assert!(!pre.is_match("bash"));
    }

    #[test]
    fn own_file_written_then_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("hooks.json");
        provision_own_file(&path, true, "{\"hooks\":{}}").unwrap();
        assert!(path.exists());
        provision_own_file(&path, false, "").unwrap();
        assert!(!path.exists());
    }

    /// RelayPaths pointing inside a fake home; not written to disk.
    fn test_relay(home: &tempfile::TempDir) -> RelayPaths {
        RelayPaths {
            sh: home.path().join("hooks").join("abundio-hook.sh"),
            ps1: home.path().join("hooks").join("abundio-hook.ps1"),
        }
    }

    #[test]
    fn provision_agent_merge_creates_dir_then_strips() {
        let home = tempfile::tempdir().unwrap();
        let relay = test_relay(&home);

        // create_dir scaffolds ~/.claude and writes settings.json with the marker.
        provision_agent(home.path(), &relay, "claude", true, true).unwrap();
        assert!(home.path().join(".claude").join("settings.json").exists());
        assert!(is_provisioned(home.path(), &relay, "claude"));

        // Disable strips Abundio's entries → no longer registered.
        provision_agent(home.path(), &relay, "claude", false, false).unwrap();
        assert!(!is_provisioned(home.path(), &relay, "claude"));
    }

    #[test]
    fn provision_agent_no_litter_when_dir_absent() {
        let home = tempfile::tempdir().unwrap();
        let relay = test_relay(&home);
        // create_dir=false (startup/toggle): an absent config dir is left alone.
        provision_agent(home.path(), &relay, "gemini", true, false).unwrap();
        assert!(!home.path().join(".gemini").exists());
        assert!(!is_provisioned(home.path(), &relay, "gemini"));
    }

    #[test]
    fn provision_agent_owned_codex_presence_is_registered() {
        let home = tempfile::tempdir().unwrap();
        let relay = test_relay(&home);
        provision_agent(home.path(), &relay, "codex", true, true).unwrap();
        assert!(home.path().join(".codex").join("hooks.json").exists());
        assert!(is_provisioned(home.path(), &relay, "codex"));
        provision_agent(home.path(), &relay, "codex", false, false).unwrap();
        assert!(!home.path().join(".codex").join("hooks.json").exists());
        assert!(!is_provisioned(home.path(), &relay, "codex"));
    }

    #[test]
    fn provision_agent_unsupported_is_noop() {
        let home = tempfile::tempdir().unwrap();
        let relay = test_relay(&home);
        provision_agent(home.path(), &relay, "aider", true, true).unwrap();
        // No descriptor → nothing scaffolded in the fake home.
        assert!(std::fs::read_dir(home.path()).unwrap().next().is_none());
        assert!(!is_provisioned(home.path(), &relay, "aider"));
    }

    #[test]
    fn config_state_classifies_absent_broken_and_registered() {
        let home = tempfile::tempdir().unwrap();
        let relay = test_relay(&home);

        // Absent file → NotRegistered.
        assert_eq!(
            config_state(home.path(), &relay, "claude"),
            HookConfigState::NotRegistered
        );

        // Unparseable merge config → ConfigError (Abundio won't touch it).
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        fs::write(home.path().join(".claude").join("settings.json"), "{ not json").unwrap();
        assert_eq!(
            config_state(home.path(), &relay, "claude"),
            HookConfigState::ConfigError
        );

        // Valid config + provisioned → Registered.
        fs::write(home.path().join(".claude").join("settings.json"), "{}").unwrap();
        provision_agent(home.path(), &relay, "claude", true, false).unwrap();
        assert_eq!(
            config_state(home.path(), &relay, "claude"),
            HookConfigState::Registered
        );
    }
}
