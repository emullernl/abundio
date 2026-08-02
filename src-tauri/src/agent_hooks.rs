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
#[cfg(not(windows))]
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
    // Deliberately SHARED across versions, unlike the database and the shell
    // integration scripts: the relay is version-independent (it reads its port
    // and token from the pane's environment at fire time), and a second copy
    // would mean provisioning the user's global agent config twice.
    crate::app_paths::hooks_dir()
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
        // SubagentStart/SubagentStop drive the ADR-0022 hold: the pane stays
        // Working past `Stop` while background subagents still run. Qwen forked
        // from Gemini CLI but has since adopted Claude's hook vocabulary
        // (verified against qwen 0.15.6: PascalCase events, no BeforeAgent/
        // AfterAgent), so it registers Claude's set — see
        // docs/plans/subagent-aware-status.md.
        "claude" | "qwen" => vec![
            ("UserPromptSubmit", None, true),
            ("PermissionRequest", None, true),
            ("Stop", None, true),
            ("StopFailure", None, true),
            ("SubagentStart", None, true),
            ("SubagentStop", None, true),
            ("SessionEnd", None, true),
        ],
        // Gemini: `Notification` is its only permission signal. We register it
        // without a matcher (the exact tool-permission matcher token is
        // undocumented; a wrong matcher would fire never). Non-permission
        // notifications also flipping to "waiting" is an accepted limitation.
        // No subagent events exist — Gemini subagents are synchronous tool
        // calls, so AfterAgent cannot fire while one runs.
        "gemini" => vec![
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

/// Merge (or strip) Abundio's `[[hooks]]` entries in a co-owned TOML config
/// (Kimi Code's `config.toml`). Counterpart of `provision_merge_settings` for
/// `ConfigFormat::Toml`; `toml_edit` preserves the user's comments and layout,
/// where a serde rewrite would destroy them. Abundio's entries are recognized
/// by the relay path inside `command` — Kimi's strict loader forbids any
/// marker key (only event/matcher/command/timeout are legal; an unknown key
/// makes kimi reject its whole hooks section, silencing the user's own hooks).
fn provision_merge_toml_hooks(
    path: &Path,
    enabled: bool,
    agent: &str,
    relay: &Path,
) -> Result<(), AbundioError> {
    let relay_marker = relay.to_string_lossy().into_owned();

    let mut doc: toml_edit::DocumentMut = if path.exists() {
        let text = fs::read_to_string(path)?;
        text.parse().map_err(|e| {
            io_err(format!(
                "{} is not valid TOML ({}) — skipped hook provisioning",
                path.display(),
                e
            ))
        })?
    } else if enabled {
        toml_edit::DocumentMut::new()
    } else {
        return Ok(()); // nothing to strip
    };

    // Always strip prior Abundio entries first — idempotent, and the disable
    // path. `hooks` may be either the `[[hooks]]` header form (ArrayOfTables)
    // or the equally-legal inline form `hooks = [{ ... }]` (a Value array of
    // inline tables) — both are handled, keeping whichever form the user wrote.
    if let Some(item) = doc.get_mut("hooks") {
        if let Some(hooks) = item.as_array_of_tables_mut() {
            hooks.retain(|t| {
                !t.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(relay_marker.as_str()))
                    .unwrap_or(false)
            });
        } else if let Some(arr) = item.as_value_mut().and_then(|v| v.as_array_mut()) {
            arr.retain(|v| {
                !v.as_inline_table()
                    .and_then(|t| t.get("command"))
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(relay_marker.as_str()))
                    .unwrap_or(false)
            });
        }
    }

    if enabled {
        let item = doc
            .entry("hooks")
            .or_insert(toml_edit::Item::ArrayOfTables(Default::default()));
        if let Some(hooks) = item.as_array_of_tables_mut() {
            for event in KIMI_EVENTS {
                let mut t = toml_edit::Table::new();
                t["event"] = toml_edit::value(*event);
                t["command"] = toml_edit::value(command_str(relay, event, agent));
                hooks.push(t);
            }
        } else if let Some(arr) = item.as_value_mut().and_then(|v| v.as_array_mut()) {
            // The user keeps their hooks in the inline form — append matching
            // inline tables rather than forcing a format change on their file.
            for event in KIMI_EVENTS {
                let mut t = toml_edit::InlineTable::new();
                t.insert("event", (*event).into());
                t.insert("command", command_str(relay, event, agent).into());
                arr.push(toml_edit::Value::InlineTable(t));
            }
        } else {
            return Err(io_err(format!(
                "{} has a non-array `hooks` key — skipped hook provisioning",
                path.display()
            )));
        }
    }

    // Tidy: drop an emptied hooks array (either form) so a disable leaves no trace.
    let hooks_emptied = doc
        .get("hooks")
        .map(|item| {
            item.as_array_of_tables()
                .map(|a| a.is_empty())
                .or_else(|| item.as_array().map(|a| a.is_empty()))
                .unwrap_or(false)
        })
        .unwrap_or(false);
    if hooks_emptied {
        doc.remove("hooks");
    }

    write_atomic(path, &doc.to_string())?;
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
    for event in [
        "UserPromptSubmit",
        "PermissionRequest",
        "Stop",
        "SubagentStart",
        "SubagentStop",
    ] {
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
    // subagentStart/subagentStop drive the ADR-0022 hold. Known gaps: Copilot's
    // built-in `general-purpose` agent emits neither event, and the payload
    // carries only `agentName` (no instance id) — see
    // docs/plans/subagent-aware-status.md.
    for (event, matcher) in [
        ("userPromptSubmitted", None),
        ("preToolUse", Some("exit_plan_mode|ask_user")),
        ("notification", Some("permission_prompt")),
        ("subagentStart", None),
        ("subagentStop", None),
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

/// Grok Build hooks file (Abundio-owned, personal scope `~/.grok/hooks/`).
/// Claude-compatible matcher-group schema, so `make_group` produces the right
/// shape. Grok rejects a matcher on the lifecycle events (SessionStart,
/// SessionEnd, Stop, UserPromptSubmit) — only `Notification` gets one here.
/// `type: "http"` hooks exist but are unusable: the loopback port is
/// per-launch, so the env-driven relay script is used like every other agent.
/// Hook failures are fail-open on Grok's side and the relay always exits 0,
/// so a dead relay can never block a tool call.
fn grok_config(relay: &Path) -> Result<String, AbundioError> {
    let mut hooks = serde_json::Map::new();
    for event in GROK_EVENTS {
        let cmd = command_str(relay, event, "grok");
        let matcher = (*event == "Notification").then_some(GROK_NOTIFICATION_MATCHER);
        hooks.insert(event.to_string(), json!([make_group(matcher, &cmd, false)]));
    }
    serde_json::to_string_pretty(&json!({ "hooks": hooks }))
        .map_err(|e| io_err(e.to_string()))
}

/// OpenCode plugin source (Abundio-owned). Forwards lifecycle events directly
/// to the loopback server — OpenCode plugins are JS, so no relay is needed.
fn opencode_plugin() -> String {
    r#"// Abundio agent status hook plugin — auto-generated, do not edit.
// Forwards OpenCode lifecycle events to Abundio's loopback status server.
export const AbundioStatus = async () => {
  const post = (type, properties) => {
    const pty = process.env.ABUNDIO_PTY_ID;
    const port = process.env.ABUNDIO_HOOK_PORT;
    const token = process.env.ABUNDIO_HOOK_TOKEN;
    if (!pty || !port || !type) return;
    // The payload lets Abundio tell child (subagent) sessions apart from the
    // pane's own session (info.parentID / sessionID) — see ADR-0022.
    let body = "{}";
    try {
      body = JSON.stringify(properties ?? {});
    } catch {}
    fetch(
      `http://127.0.0.1:${port}/hook?event=${encodeURIComponent(type)}` +
        `&agent=opencode&pty=${encodeURIComponent(pty)}`,
      { method: "POST", headers: { "X-Abundio-Token": token ?? "" }, body },
    ).catch(() => {});
  };
  return {
    event: async ({ event }) => {
      post(event && event.type, event && event.properties);
    },
  };
};
"#
    .to_string()
}

/// Warning surfaced when `curl` is missing on Unix. Shared by `provision` and
/// `ensure_agent_hooks` so both paths give the same diagnostic instead of
/// scaffolding hooks that can never fire.
#[cfg(not(windows))]
const CURL_MISSING_WARNING: &str = "`curl` was not found on PATH — Agent status \
     hooks were registered but won't fire. Install curl (e.g. `apt install curl`) \
     and toggle the setting off and on again.";

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
const SUPPORTED_AGENTS: &[&str] = &[
    "claude", "gemini", "qwen", "codex", "copilot", "opencode", "kimi", "grok",
];

/// Grok Build (xAI) hook events Abundio registers. Grok's hook system is a
/// Claude-compatible reimplementation (it even loads `.claude/settings.json`),
/// but Abundio provisions a standalone personal-scope file in `~/.grok/hooks/`
/// instead — global hook files there are always trusted (no folder-trust gate,
/// unlike project-scope hooks). PostToolUse/PreCompact/PostCompact are
/// deliberately absent: per-tool noise with no status value.
/// `Notification` is matcher-scoped (the matcher regex tests Grok's
/// `notificationType`) to the two first-party blocking types — plugins can
/// dispatch arbitrary notification types, so an unscoped hook would flip
/// Waiting on non-prompts. Grok has NO permission-granted event (unlike
/// Kimi's PermissionResult), and its permission pipeline runs — emitting the
/// `permission_prompt` notification — even for prompts that resolve without
/// a local keystroke (always-approve mode, the LLM-classifier mode,
/// remembered grants, a mid-prompt Ctrl+O toggle, relay approvals), so
/// Waiting would otherwise wedge until turn end. NOTE the in-tool-call
/// ordering: `PreToolUse` fires BEFORE the permission gate (grok-build
/// tool_calls.rs dispatches it ahead of `permissions.request_*`), so its
/// frontend "resume" mapping (lift Waiting → Working, else a strict no-op —
/// deliberately NOT "active", which would reset the working window on every
/// tool call) can only heal the PREVIOUS tool's stale Waiting. The
/// self-resolving modes are instead discriminated on the frontend via the
/// envelope's `permissionMode` field (auto/bypassPermissions
/// permission_prompts map to "resume", see agentHookMap.ts).
/// `PermissionDenied` gives
/// the authoritative resume out of Waiting on a deny; `Stop` carries
/// `reason: end_turn|cancelled|error` which the frontend branches on (a
/// cancelled turn goes to Idle, not Ready).
/// Verified against github.com/xai-org/grok-build (xai-grok-hooks/src/event.rs,
/// xai-grok-shell acp_session_impl) and the bundled user guide.
const GROK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "Notification",
    "PreToolUse",
    "PermissionDenied",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "SessionEnd",
];

/// Matcher for Grok's `Notification` hook: only the first-party notification
/// types that mean "blocked on the user" (tool/plan permission prompts and
/// free-form user questions). Grok tests this regex against `notificationType`.
const GROK_NOTIFICATION_MATCHER: &str = "permission_prompt|elicitation_dialog";

/// Kimi Code hook events Abundio registers (Claude vocabulary; hooks are Beta).
/// Kimi's `[[hooks]]` entries allow ONLY event/matcher/command/timeout — an
/// extra key makes kimi reject and ignore its ENTIRE hooks section (verified
/// against kimi 0.27.0: "Warning: Ignored invalid config … : hooks"), killing
/// the user's own hooks too — so Abundio's entries are identified by the relay
/// path in `command`, never by a marker field. `PermissionResult`
/// and `Interrupt` have no Claude equivalent: they give an authoritative
/// "prompt answered" resume and a user-cancel that would otherwise strand the
/// pane on Working.
const KIMI_EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "PermissionRequest",
    "PermissionResult",
    "Stop",
    "StopFailure",
    "Interrupt",
    "SubagentStart",
    "SubagentStop",
    "SessionEnd",
];

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

/// On-disk format of a `Merged` config file. Internal routing only — the
/// frontend-facing `Ownership` is unaffected. (`Owned` files ignore this.)
#[derive(Clone, Copy, PartialEq)]
enum ConfigFormat {
    Json,
    Toml,
}

/// Static provisioning facts for one supported agent.
struct AgentDescriptor {
    /// Config dir, relative to `$HOME`, whose existence gates startup provisioning.
    dir_rel: PathBuf,
    /// Config file Abundio touches, relative to `$HOME`.
    config_rel: PathBuf,
    ownership: Ownership,
    format: ConfigFormat,
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
            format: ConfigFormat::Json,
            events: merge_events("claude"),
        }),
        "gemini" => Some(AgentDescriptor {
            dir_rel: PathBuf::from(".gemini"),
            config_rel: [".gemini", "settings.json"].iter().collect(),
            ownership: Ownership::Merged,
            format: ConfigFormat::Json,
            events: merge_events("gemini"),
        }),
        "qwen" => Some(AgentDescriptor {
            dir_rel: PathBuf::from(".qwen"),
            config_rel: [".qwen", "settings.json"].iter().collect(),
            ownership: Ownership::Merged,
            format: ConfigFormat::Json,
            events: merge_events("qwen"),
        }),
        "codex" => Some(AgentDescriptor {
            dir_rel: PathBuf::from(".codex"),
            config_rel: [".codex", "hooks.json"].iter().collect(),
            ownership: Ownership::Owned,
            format: ConfigFormat::Json,
            events: owned_events(&[
                "UserPromptSubmit",
                "PermissionRequest",
                "Stop",
                "SubagentStart",
                "SubagentStop",
            ]),
        }),
        "copilot" => Some(AgentDescriptor {
            dir_rel: PathBuf::from(".copilot"),
            config_rel: [".copilot", "hooks", "abundio.json"].iter().collect(),
            ownership: Ownership::Owned,
            format: ConfigFormat::Json,
            events: owned_events(&[
                "userPromptSubmitted",
                "preToolUse",
                "notification",
                "subagentStart",
                "subagentStop",
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
            format: ConfigFormat::Json,
            events: vec!["all lifecycle events".to_string()],
        }),
        // Kimi Code's config home is relocatable via KIMI_CODE_HOME; like the
        // other descriptors (CLAUDE_CONFIG_DIR is equally unhonored) only the
        // default location is supported.
        "kimi" => Some(AgentDescriptor {
            dir_rel: PathBuf::from(".kimi-code"),
            config_rel: [".kimi-code", "config.toml"].iter().collect(),
            ownership: Ownership::Merged,
            format: ConfigFormat::Toml,
            events: KIMI_EVENTS.iter().map(|s| s.to_string()).collect(),
        }),
        // Grok Build's config home is relocatable via GROK_HOME; like the other
        // descriptors only the default location is supported. `dir_rel` is
        // `.grok` (not `.grok/hooks`) so the no-litter gate keys off "is grok
        // installed at all" — write_atomic creates the `hooks/` parent.
        "grok" => Some(AgentDescriptor {
            dir_rel: PathBuf::from(".grok"),
            config_rel: [".grok", "hooks", "abundio.json"].iter().collect(),
            ownership: Ownership::Owned,
            format: ConfigFormat::Json,
            events: GROK_EVENTS.iter().map(|s| s.to_string()).collect(),
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
        "grok" => grok_config(relay.primary()),
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
        Ownership::Merged => match desc.format {
            ConfigFormat::Json => {
                provision_merge_settings(&path, enabled, agent_id, relay.primary())
            }
            ConfigFormat::Toml => {
                provision_merge_toml_hooks(&path, enabled, agent_id, relay.primary())
            }
        },
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

/// True when a parsed merge config carries an Abundio group for EVERY event the
/// current binary registers — not merely "some marker present". Presence-only
/// classification left a config written by an older Abundio (fewer/renamed
/// events) reading as Registered, so `ensure_agent_hooks` never upgraded it at
/// agent launch (the subagent-events rollout tripped exactly this — see
/// docs/plans/subagent-aware-status.md).
fn merge_is_current(root: &Value, marker: &str, agent_id: &str) -> bool {
    let events = merge_agent_events(agent_id);
    if events.is_empty() {
        return false;
    }
    let Some(hooks) = root.get("hooks").and_then(|h| h.as_object()) else {
        return false;
    };
    events.iter().all(|(event, _, _)| {
        hooks
            .get(*event)
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().any(|g| group_is_abundio(g, marker)))
            .unwrap_or(false)
    })
}

/// TOML counterpart of `merge_is_current`: every event in `events` must have a
/// hook entry whose `event` matches and whose `command` carries the relay
/// marker, so an older Abundio's event set reads as not-registered and
/// `ensure_agent_hooks` upgrades it at agent launch. Recognizes both the
/// `[[hooks]]` header form and the inline `hooks = [{ ... }]` form, matching
/// `provision_merge_toml_hooks`.
fn toml_merge_is_current(doc: &toml_edit::DocumentMut, marker: &str, events: &[&str]) -> bool {
    if events.is_empty() {
        return false;
    }
    let Some(item) = doc.get("hooks") else {
        return false;
    };
    // (event, command) pairs from whichever representation the file uses.
    let pairs: Vec<(Option<&str>, Option<&str>)> = if let Some(aot) = item.as_array_of_tables() {
        aot.iter()
            .map(|t| {
                (
                    t.get("event").and_then(|e| e.as_str()),
                    t.get("command").and_then(|c| c.as_str()),
                )
            })
            .collect()
    } else if let Some(arr) = item.as_array() {
        arr.iter()
            .filter_map(|v| v.as_inline_table())
            .map(|t| {
                (
                    t.get("event").and_then(|e| e.as_str()),
                    t.get("command").and_then(|c| c.as_str()),
                )
            })
            .collect()
    } else {
        return false;
    };
    events.iter().all(|event| {
        pairs.iter().any(|(e, c)| {
            *e == Some(*event) && c.map(|c| c.contains(marker)).unwrap_or(false)
        })
    })
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
            let marker = relay.primary().to_string_lossy();
            match desc.format {
                ConfigFormat::Json => match serde_json::from_str::<Value>(&text) {
                    Err(_) => HookConfigState::ConfigError,
                    Ok(root) => {
                        if merge_is_current(&root, &marker, agent_id) {
                            HookConfigState::Registered
                        } else {
                            HookConfigState::NotRegistered
                        }
                    }
                },
                ConfigFormat::Toml => match text.parse::<toml_edit::DocumentMut>() {
                    Err(_) => HookConfigState::ConfigError,
                    Ok(doc) => {
                        if toml_merge_is_current(&doc, &marker, KIMI_EVENTS) {
                            HookConfigState::Registered
                        } else {
                            HookConfigState::NotRegistered
                        }
                    }
                },
            }
        }
        // Abundio owns the whole file: Registered means the on-disk content
        // equals what this binary would write. Anything else — a stale relay
        // path after a data-dir change, an older event set, an outdated
        // opencode plugin body — reads as not-registered and gets refreshed by
        // the next ensure/provision pass.
        Ownership::Owned => match fs::read_to_string(&path) {
            Err(_) => HookConfigState::NotRegistered, // file absent
            Ok(text) => match owned_content(agent_id, relay) {
                Ok(expected) if text == expected => HookConfigState::Registered,
                _ => HookConfigState::NotRegistered,
            },
        },
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
    // We just wrote hook configs. On Unix the relay POSTs via curl; warn (as
    // provision() does) so a curl-less box gets a diagnostic via the caller's
    // .catch instead of silently-installed-but-never-firing hooks. Fires at
    // most once per agent — subsequent launches short-circuit on is_provisioned.
    #[cfg(not(windows))]
    if !curl_available() {
        return Err(io_err(CURL_MISSING_WARNING.to_string()));
    }
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
        errors.push(CURL_MISSING_WARNING.to_string());
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
    fn merge_registers_subagent_events_for_claude_and_qwen() {
        // ADR-0022: SubagentStart/SubagentStop drive the Working hold. Qwen
        // registers Claude's vocabulary (it diverged from Gemini CLI).
        for agent in ["claude", "qwen"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("settings.json");
            provision_merge_settings(&path, true, agent, &relay()).unwrap();
            let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            for event in ["SubagentStart", "SubagentStop", "Stop", "UserPromptSubmit"] {
                let groups = v["hooks"][event]
                    .as_array()
                    .unwrap_or_else(|| panic!("{agent}: {event} missing"));
                assert!(
                    groups.iter().any(|g| group_is_abundio(g, "abundio-hook.sh")),
                    "{agent}: {event} must carry an Abundio group"
                );
            }
            // Qwen must NOT register the old Gemini-style events.
            if agent == "qwen" {
                assert!(v["hooks"].get("BeforeAgent").is_none());
                assert!(v["hooks"].get("AfterAgent").is_none());
            }
        }
    }

    #[test]
    fn merge_upgrades_old_event_set_without_duplicates() {
        // A settings.json provisioned by an older Abundio (pre-subagent events,
        // and Gemini-style names for qwen) must upgrade in place: stale Abundio
        // groups stripped, the current set added exactly once, user keys kept.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let old_cmd = format!("sh \"{}\" BeforeAgent qwen", relay().to_string_lossy());
        fs::write(
            &path,
            serde_json::to_string(&json!({
                "theme": "dark",
                "hooks": { "BeforeAgent": [ { "hooks": [ { "type": "command", "command": old_cmd } ] } ] }
            }))
            .unwrap(),
        )
        .unwrap();

        provision_merge_settings(&path, true, "qwen", &relay()).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();

        assert_eq!(v["theme"], "dark");
        // The stale Gemini-style Abundio group is gone (empty arrays may remain).
        let stale = v["hooks"]["BeforeAgent"]
            .as_array()
            .map(|groups| {
                groups
                    .iter()
                    .any(|g| group_is_abundio(g, "abundio-hook.sh"))
            })
            .unwrap_or(false);
        assert!(!stale, "old-style Abundio group must be stripped");
        // The new events are present exactly once.
        for event in ["SubagentStart", "SubagentStop", "Stop"] {
            let count = v["hooks"][event]
                .as_array()
                .unwrap()
                .iter()
                .filter(|g| group_is_abundio(g, "abundio-hook.sh"))
                .count();
            assert_eq!(count, 1, "{event} must appear exactly once");
        }
    }

    #[test]
    fn stale_event_set_reads_not_registered_so_ensure_upgrades_it() {
        // The self-heal path: is_provisioned must be event-set-aware, so an
        // agent launch (ensure_agent_hooks) upgrades a config written by an
        // older Abundio instead of short-circuiting on marker presence.
        let home = tempfile::tempdir().unwrap();
        let relay = test_relay(&home);
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        let path = home.path().join(".claude").join("settings.json");

        // Simulate the pre-subagent-events footprint: provision, then strip
        // the two new event groups the way an old binary's write would lack them.
        provision_agent(home.path(), &relay, "claude", true, false).unwrap();
        assert!(is_provisioned(home.path(), &relay, "claude"));
        let mut v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let hooks = v["hooks"].as_object_mut().unwrap();
        hooks.remove("SubagentStart");
        hooks.remove("SubagentStop");
        fs::write(&path, serde_json::to_string(&v).unwrap()).unwrap();

        // Presence-only classification would say Registered here; the
        // event-set-aware check must not.
        assert!(
            !is_provisioned(home.path(), &relay, "claude"),
            "a stale event set must read as not-registered"
        );

        // Re-provisioning (what ensure_agent_hooks now does at agent launch)
        // restores the full set without duplicates.
        provision_agent(home.path(), &relay, "claude", true, false).unwrap();
        assert!(is_provisioned(home.path(), &relay, "claude"));
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        for event in ["SubagentStart", "SubagentStop", "Stop"] {
            let count = v["hooks"][event]
                .as_array()
                .unwrap()
                .iter()
                .filter(|g| group_is_abundio(g, "abundio-hook.sh"))
                .count();
            assert_eq!(count, 1, "{event} must appear exactly once");
        }
    }

    #[test]
    fn stale_owned_content_reads_not_registered() {
        // Owned files (codex/copilot/opencode) are Registered only when their
        // content matches what this binary writes — an old event set or an
        // outdated opencode plugin body must trigger a refresh.
        let home = tempfile::tempdir().unwrap();
        let relay = test_relay(&home);
        fs::create_dir_all(home.path().join(".codex")).unwrap();
        provision_agent(home.path(), &relay, "codex", true, false).unwrap();
        assert!(is_provisioned(home.path(), &relay, "codex"));

        // An older binary's file: same relay path, fewer events.
        let path = home.path().join(".codex").join("hooks.json");
        let mut v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        v["hooks"].as_object_mut().unwrap().remove("SubagentStart");
        fs::write(&path, serde_json::to_string_pretty(&v).unwrap()).unwrap();
        assert!(
            !is_provisioned(home.path(), &relay, "codex"),
            "stale owned content must read as not-registered"
        );

        // Same for the opencode plugin body (it embeds no relay path).
        let oc_dir = home.path().join(".config").join("opencode");
        fs::create_dir_all(&oc_dir).unwrap();
        provision_agent(home.path(), &relay, "opencode", true, false).unwrap();
        assert!(is_provisioned(home.path(), &relay, "opencode"));
        let oc_path = oc_dir.join("plugin").join("abundio.ts");
        fs::write(&oc_path, "// old plugin body\n").unwrap();
        assert!(
            !is_provisioned(home.path(), &relay, "opencode"),
            "an outdated opencode plugin must read as not-registered"
        );
    }

    #[test]
    fn codex_and_copilot_configs_register_subagent_events() {
        let dir = tempfile::tempdir().unwrap();
        let relay = RelayPaths {
            sh: dir.path().join("abundio-hook.sh"),
            ps1: dir.path().join("abundio-hook.ps1"),
        };
        let codex: Value = serde_json::from_str(&codex_config(relay.primary()).unwrap()).unwrap();
        assert!(codex["hooks"]["SubagentStart"].is_array());
        assert!(codex["hooks"]["SubagentStop"].is_array());

        let copilot: Value = serde_json::from_str(&copilot_config(&relay).unwrap()).unwrap();
        for event in ["subagentStart", "subagentStop"] {
            assert!(copilot["hooks"][event].is_array(), "{event} missing");
            assert!(copilot["hooks"][event][0].get("matcher").is_none());
        }
    }

    #[test]
    fn grok_config_registers_expected_events() {
        let dir = tempfile::tempdir().unwrap();
        let relay = RelayPaths {
            sh: dir.path().join("abundio-hook.sh"),
            ps1: dir.path().join("abundio-hook.ps1"),
        };
        let v: Value = serde_json::from_str(&grok_config(relay.primary()).unwrap()).unwrap();
        let hooks = v["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), GROK_EVENTS.len());
        for event in GROK_EVENTS {
            let groups = hooks[*event].as_array().unwrap();
            assert_eq!(groups.len(), 1, "{event} must have exactly one group");
            let cmd = groups[0]["hooks"][0]["command"].as_str().unwrap();
            assert!(
                cmd.contains(&format!("{event} grok")),
                "{event} command must pass the event name and agent id"
            );
            assert!(cmd.contains("abundio-hook"), "{event} must use the relay");
        }

        // Notification is matcher-scoped to the two first-party blocking
        // notification types (permission prompts / user questions) — plugins
        // can dispatch arbitrary types, which must not flip Waiting.
        let notif = hooks["Notification"].as_array().unwrap();
        let matcher = notif[0]["matcher"].as_str().unwrap();
        assert_eq!(matcher, GROK_NOTIFICATION_MATCHER);
        let re = regex::Regex::new(&format!("^(?:{matcher})$")).expect("matcher must compile");
        assert!(re.is_match("permission_prompt"));
        assert!(re.is_match("elicitation_dialog"));
        assert!(!re.is_match("task_update"));

        // Grok REJECTS a matcher on lifecycle events (SessionStart/SessionEnd/
        // Stop/UserPromptSubmit) — one there would kill the hook at load time.
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "SessionEnd",
            "StopFailure",
        ] {
            assert!(
                hooks[event][0].get("matcher").is_none(),
                "{event} must carry no matcher"
            );
        }
    }

    #[test]
    fn grok_provisioning_owned_lifecycle_and_self_heal() {
        let home = tempfile::tempdir().unwrap();
        let relay = test_relay(&home);

        // No ~/.grok dir → no-litter: nothing written.
        provision_agent(home.path(), &relay, "grok", true, false).unwrap();
        assert!(!home.path().join(".grok").exists());

        // With the dir present, provisioning creates hooks/abundio.json
        // (write_atomic scaffolds the hooks/ parent).
        fs::create_dir_all(home.path().join(".grok")).unwrap();
        provision_agent(home.path(), &relay, "grok", true, false).unwrap();
        let path = home.path().join(".grok").join("hooks").join("abundio.json");
        assert!(path.exists());
        assert!(is_provisioned(home.path(), &relay, "grok"));

        // An older binary's file (fewer events) reads as not-registered and
        // re-provisioning heals it.
        let mut v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        v["hooks"].as_object_mut().unwrap().remove("SubagentStart");
        fs::write(&path, serde_json::to_string_pretty(&v).unwrap()).unwrap();
        assert!(!is_provisioned(home.path(), &relay, "grok"));
        provision_agent(home.path(), &relay, "grok", true, false).unwrap();
        assert!(is_provisioned(home.path(), &relay, "grok"));

        // Disable deletes only Abundio's own file.
        provision_agent(home.path(), &relay, "grok", false, false).unwrap();
        assert!(!path.exists());
        assert!(home.path().join(".grok").exists());
    }

    #[test]
    fn opencode_plugin_forwards_event_properties() {
        // The payload lets the frontend tell child (subagent) sessions apart
        // from the pane's own session (ADR-0022).
        let src = opencode_plugin();
        assert!(src.contains("event.properties"));
        assert!(src.contains("JSON.stringify"));
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
    fn owned_codex_with_stale_relay_path_is_not_registered() {
        let home = tempfile::tempdir().unwrap();
        // Provision against one relay dir, then inspect against a different one
        // (simulating a data-dir change): the embedded path is now stale.
        let old_relay = RelayPaths {
            sh: home.path().join("old").join("abundio-hook.sh"),
            ps1: home.path().join("old").join("abundio-hook.ps1"),
        };
        provision_agent(home.path(), &old_relay, "codex", true, true).unwrap();
        assert!(is_provisioned(home.path(), &old_relay, "codex"));

        let new_relay = RelayPaths {
            sh: home.path().join("new").join("abundio-hook.sh"),
            ps1: home.path().join("new").join("abundio-hook.ps1"),
        };
        assert!(
            !is_provisioned(home.path(), &new_relay, "codex"),
            "a stale embedded relay path must read as not-registered"
        );
    }

    #[test]
    fn owned_opencode_presence_is_registered_regardless_of_relay() {
        let home = tempfile::tempdir().unwrap();
        // OpenCode's plugin embeds no relay path (it uses env vars), so its mere
        // presence means registered even when inspected against another relay.
        let relay_a = test_relay(&home);
        provision_agent(home.path(), &relay_a, "opencode", true, true).unwrap();
        let relay_b = RelayPaths {
            sh: home.path().join("elsewhere").join("abundio-hook.sh"),
            ps1: home.path().join("elsewhere").join("abundio-hook.ps1"),
        };
        assert!(is_provisioned(home.path(), &relay_b, "opencode"));
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

    // ── Kimi Code: TOML merge into a user-owned config.toml ──

    /// A config.toml the way a real Kimi user might keep it: comments, own
    /// keys, and an own [[hooks]] entry that must all survive Abundio's merge.
    const KIMI_USER_CONFIG: &str = r#"# my kimi setup — do not lose this comment
model = "kimi-k3"

[[hooks]]
# my own safety gate
event = "PreToolUse"
matcher = "Shell"
command = "~/.kimi/hooks/safety-check.sh"
timeout = 10
"#;

    #[test]
    fn kimi_toml_merge_adds_then_strips_preserving_user_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, KIMI_USER_CONFIG).unwrap();

        // Enable twice — must not duplicate Abundio entries.
        provision_merge_toml_hooks(&path, true, "kimi", &relay()).unwrap();
        provision_merge_toml_hooks(&path, true, "kimi", &relay()).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let doc: toml_edit::DocumentMut = text.parse().unwrap();

        // User comment and own keys survive.
        assert!(text.contains("do not lose this comment"));
        assert!(text.contains("# my own safety gate"));
        assert_eq!(doc["model"].as_str(), Some("kimi-k3"));
        let hooks = doc["hooks"].as_array_of_tables().unwrap();
        let abundio_count = |hooks: &toml_edit::ArrayOfTables| {
            hooks
                .iter()
                .filter(|t| {
                    t.get("command")
                        .and_then(|c| c.as_str())
                        .map(|c| c.contains("abundio-hook.sh"))
                        .unwrap_or(false)
                })
                .count()
        };
        assert_eq!(
            abundio_count(hooks),
            KIMI_EVENTS.len(),
            "re-provisioning must not duplicate"
        );
        assert_eq!(hooks.len(), KIMI_EVENTS.len() + 1, "user's own hook must survive");

        // Disable — byte-identical to the original user file.
        provision_merge_toml_hooks(&path, false, "kimi", &relay()).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            KIMI_USER_CONFIG,
            "disable must restore the user's file byte-for-byte"
        );
    }

    #[test]
    fn kimi_toml_entries_carry_only_allowed_keys() {
        // Kimi rejects its ENTIRE hooks section on any unknown key in a
        // [[hooks]] entry (verified against kimi 0.27.0) — a future "helpful"
        // extra field would silently kill the user's own hooks along with
        // Abundio's. Exactly `event` + `command`, nothing else.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        provision_merge_toml_hooks(&path, true, "kimi", &relay()).unwrap();
        let doc: toml_edit::DocumentMut =
            fs::read_to_string(&path).unwrap().parse().unwrap();
        let hooks = doc["hooks"].as_array_of_tables().unwrap();
        assert_eq!(hooks.len(), KIMI_EVENTS.len());
        for t in hooks.iter() {
            let keys: Vec<&str> = t.iter().map(|(k, _)| k).collect();
            assert_eq!(keys, ["event", "command"], "only Kimi-legal keys allowed");
            let event = t["event"].as_str().unwrap();
            assert!(KIMI_EVENTS.contains(&event));
            let cmd = t["command"].as_str().unwrap();
            assert!(cmd.contains("abundio-hook.sh"));
            assert!(cmd.contains(event), "command must carry its event name");
            assert!(cmd.contains("kimi"), "command must carry the agent id");
        }
    }

    #[test]
    fn kimi_toml_merge_aborts_on_unparseable_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "this = is not [ valid toml").unwrap();
        let result = provision_merge_toml_hooks(&path, true, "kimi", &relay());
        assert!(result.is_err());
        // The corrupt file must be left untouched.
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "this = is not [ valid toml"
        );
    }

    #[test]
    fn kimi_toml_merge_aborts_on_non_array_hooks_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "[hooks]\nfoo = 1\n").unwrap();
        let before = fs::read_to_string(&path).unwrap();
        assert!(provision_merge_toml_hooks(&path, true, "kimi", &relay()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn kimi_toml_merge_handles_inline_array_hooks_form() {
        // TOML allows `hooks = [{ ... }]` as well as `[[hooks]]` — a user
        // keeping the inline form must still be able to register, self-heal,
        // and strip, without Abundio rewriting their file into header form.
        let user_config = "model = \"kimi-k3\"\nhooks = [{ event = \"PreToolUse\", command = \"my-own-hook\" }]\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, user_config).unwrap();

        // Enable twice — no duplicates, user entry kept, inline form kept.
        provision_merge_toml_hooks(&path, true, "kimi", &relay()).unwrap();
        provision_merge_toml_hooks(&path, true, "kimi", &relay()).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("[[hooks]]"),
            "the user's inline form must not be rewritten to header form"
        );
        let doc: toml_edit::DocumentMut = text.parse().unwrap();
        let arr = doc["hooks"].as_array().unwrap();
        let abundio = arr
            .iter()
            .filter_map(|v| v.as_inline_table())
            .filter(|t| {
                t.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains("abundio-hook.sh"))
                    .unwrap_or(false)
            })
            .count();
        assert_eq!(abundio, KIMI_EVENTS.len(), "no duplicates on re-provision");
        assert_eq!(arr.len(), KIMI_EVENTS.len() + 1, "user's own hook survives");
        // The self-heal check must recognize the inline form as registered.
        assert!(toml_merge_is_current(
            &doc,
            "abundio-hook.sh",
            KIMI_EVENTS
        ));

        // Disable — back to exactly the user's entries.
        provision_merge_toml_hooks(&path, false, "kimi", &relay()).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("abundio-hook.sh"));
        assert!(text.contains("my-own-hook"));
        assert!(text.contains("kimi-k3"));
    }

    #[test]
    fn kimi_toml_disable_removes_emptied_inline_hooks_array() {
        // Fresh file provisioned in inline form (only possible if the user had
        // `hooks = []`): a disable must tidy the emptied array away.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "hooks = []\n").unwrap();
        provision_merge_toml_hooks(&path, true, "kimi", &relay()).unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("abundio-hook.sh"));
        provision_merge_toml_hooks(&path, false, "kimi", &relay()).unwrap();
        assert!(!fs::read_to_string(&path).unwrap().contains("hooks"));
    }

    #[test]
    fn kimi_stale_event_set_reads_not_registered_so_ensure_upgrades_it() {
        // Same self-heal contract as the JSON agents: a config.toml written by
        // an older Abundio (fewer events) must not read as Registered, and a
        // re-provision restores the full set exactly once per event.
        let home = tempfile::tempdir().unwrap();
        let relay = test_relay(&home);
        fs::create_dir_all(home.path().join(".kimi-code")).unwrap();
        let path = home.path().join(".kimi-code").join("config.toml");

        provision_agent(home.path(), &relay, "kimi", true, false).unwrap();
        assert!(is_provisioned(home.path(), &relay, "kimi"));

        // Simulate an older binary's footprint: drop one event's table.
        let mut doc: toml_edit::DocumentMut =
            fs::read_to_string(&path).unwrap().parse().unwrap();
        doc["hooks"]
            .as_array_of_tables_mut()
            .unwrap()
            .retain(|t| t["event"].as_str() != Some("Interrupt"));
        fs::write(&path, doc.to_string()).unwrap();
        assert!(
            !is_provisioned(home.path(), &relay, "kimi"),
            "a stale event set must read as not-registered"
        );

        provision_agent(home.path(), &relay, "kimi", true, false).unwrap();
        assert!(is_provisioned(home.path(), &relay, "kimi"));
        let doc: toml_edit::DocumentMut =
            fs::read_to_string(&path).unwrap().parse().unwrap();
        assert_eq!(
            doc["hooks"].as_array_of_tables().unwrap().len(),
            KIMI_EVENTS.len(),
            "exactly one entry per event after the upgrade"
        );
    }

    #[test]
    fn kimi_dir_gating_and_config_state() {
        let home = tempfile::tempdir().unwrap();
        let relay = test_relay(&home);

        // No-litter: absent ~/.kimi-code with create_dir=false is left alone.
        provision_agent(home.path(), &relay, "kimi", true, false).unwrap();
        assert!(!home.path().join(".kimi-code").exists());
        assert_eq!(
            config_state(home.path(), &relay, "kimi"),
            HookConfigState::NotRegistered
        );

        // Unparseable config.toml → ConfigError (Abundio won't touch it).
        fs::create_dir_all(home.path().join(".kimi-code")).unwrap();
        let path = home.path().join(".kimi-code").join("config.toml");
        fs::write(&path, "not [ toml").unwrap();
        assert_eq!(
            config_state(home.path(), &relay, "kimi"),
            HookConfigState::ConfigError
        );

        // Launch path (create_dir=true) provisions a fresh file → Registered;
        // disable strips it back to no hooks at all.
        fs::write(&path, "").unwrap();
        provision_agent(home.path(), &relay, "kimi", true, true).unwrap();
        assert_eq!(
            config_state(home.path(), &relay, "kimi"),
            HookConfigState::Registered
        );
        provision_agent(home.path(), &relay, "kimi", false, false).unwrap();
        assert!(!is_provisioned(home.path(), &relay, "kimi"));
        assert!(!fs::read_to_string(&path).unwrap().contains("abundio-hook"));
    }
}
