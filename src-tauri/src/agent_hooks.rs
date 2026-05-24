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

use serde_json::{json, Value};

use crate::error::AbundioError;

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
    -Headers @{ "X-Abundio-Token" = "$($env:ABUNDIO_HOOK_TOKEN)" } | Out-Null
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

/// Write both relay scripts; make the shell script executable on Unix.
fn write_relay_scripts() -> Result<RelayPaths, AbundioError> {
    let dir = relay_dir();
    fs::create_dir_all(&dir)?;
    let sh = dir.join("abundio-hook.sh");
    let ps1 = dir.join("abundio-hook.ps1");
    fs::write(&sh, RELAY_SH)?;
    fs::write(&ps1, RELAY_PS1)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&sh, fs::Permissions::from_mode(0o755))?;
    }
    Ok(RelayPaths { sh, ps1 })
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
/// keys on the command rather than a single `command`.
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
    for event in [
        "userPromptSubmitted",
        "permissionRequest",
        "preToolUse",
        // postToolUse / postToolUseFailure fire once a tool has actually run —
        // proof the permission was granted (auto or by the user). They pull
        // the dot back from "waiting" to "active"; a genuinely blocked tool
        // never reaches them. See Decision 12 in the plan doc.
        "postToolUse",
        "postToolUseFailure",
        "agentStop",
        "errorOccurred",
        "sessionEnd",
    ] {
        hooks.insert(
            event.to_string(),
            json!([{
                "type": "command",
                "bash": bash(event),
                "powershell": powershell(event),
                "timeoutSec": 5,
            }]),
        );
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

/// Enable or disable Agent status hooks across every installed Agent.
///
/// Per-agent failures are collected and reported but do not abort the rest —
/// a corrupt `~/.claude/settings.json` must not prevent provisioning Codex.
pub fn provision(enabled: bool) -> Result<(), AbundioError> {
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

    // Only touch an Agent's config when it already has a config directory —
    // avoids littering the home dir for Agents the user hasn't installed.
    let claude_dir = home.join(".claude");
    if claude_dir.is_dir() {
        if let Err(e) =
            provision_merge_settings(&claude_dir.join("settings.json"), enabled, "claude", relay.primary())
        {
            errors.push(e.to_string());
        }
    }

    let gemini_dir = home.join(".gemini");
    if gemini_dir.is_dir() {
        if let Err(e) =
            provision_merge_settings(&gemini_dir.join("settings.json"), enabled, "gemini", relay.primary())
        {
            errors.push(e.to_string());
        }
    }

    let qwen_dir = home.join(".qwen");
    if qwen_dir.is_dir() {
        if let Err(e) =
            provision_merge_settings(&qwen_dir.join("settings.json"), enabled, "qwen", relay.primary())
        {
            errors.push(e.to_string());
        }
    }

    let codex_dir = home.join(".codex");
    if codex_dir.is_dir() {
        let content = match codex_config(relay.primary()) {
            Ok(c) => c,
            Err(e) => {
                errors.push(e.to_string());
                String::new()
            }
        };
        if !content.is_empty() || !enabled {
            if let Err(e) = provision_own_file(&codex_dir.join("hooks.json"), enabled, &content) {
                errors.push(e.to_string());
            }
        }
    }

    let copilot_dir = home.join(".copilot");
    if copilot_dir.is_dir() {
        let content = match copilot_config(&relay) {
            Ok(c) => c,
            Err(e) => {
                errors.push(e.to_string());
                String::new()
            }
        };
        if !content.is_empty() || !enabled {
            if let Err(e) =
                provision_own_file(&copilot_dir.join("hooks").join("abundio.json"), enabled, &content)
            {
                errors.push(e.to_string());
            }
        }
    }

    let opencode_dir = home.join(".config").join("opencode");
    if opencode_dir.is_dir() {
        if let Err(e) = provision_own_file(
            &opencode_dir.join("plugin").join("abundio.ts"),
            enabled,
            &opencode_plugin(),
        ) {
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
    fn own_file_written_then_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("hooks.json");
        provision_own_file(&path, true, "{\"hooks\":{}}").unwrap();
        assert!(path.exists());
        provision_own_file(&path, false, "").unwrap();
        assert!(!path.exists());
    }
}
