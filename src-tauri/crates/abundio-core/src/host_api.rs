//! The host commands, in one place (docs/plans/remote-hosts.md phase 7b):
//! what a Window asks of the Host of its Profile. The desktop app runs them
//! for a local Profile (its `host_call` command) and an Abundio server for a
//! remote one (each request on its connection), so there is one copy of
//! every command, and using the app locally tests the server's code.
//!
//! [`dispatch`] takes the command's name and the arguments the Window passed
//! to `invoke` (camelCase, as Tauri would have read them) and answers with
//! what the command returns, or its error. `src/lib/hostApiCommands.ts` lists
//! the commands routed here; a test holds the two lists equal.

use std::collections::HashMap;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AbundioError;
use crate::event_sink::{ClientId, Events, EventsExt};
use crate::workspace_store::{Tab, TabUpdate, WorkspaceStore, WorkspaceUpdate};

/// What the Host knows of its Clients (the Windows showing its Profiles).
pub trait HostClients: Send + Sync {
    /// Every Client and the Profile it shows.
    fn profiles(&self) -> HashMap<String, String>;
    /// Whether the Client is still there (a spawn for a Window that closed
    /// meanwhile is killed).
    fn is_alive(&self, client: &ClientId) -> bool;
    /// A Window on this Host says which of its Profiles it shows (a remote
    /// Window, phase 7d). The desktop app keeps its own Windows' Profiles
    /// itself, so it has nothing to do here.
    fn set_profile(&self, _client: &ClientId, _profile_id: &str) {}
}

/// Everything a host command reaches.
pub struct Host<'a> {
    pub workspaces: &'a WorkspaceStore,
    pub profiles: &'a crate::profile_store::ProfileStore,
    pub ptys: &'a crate::pty_manager::PtyManager,
    pub status: &'a crate::status_store::StatusStore,
    pub layouts: &'a crate::layout_store::LayoutStore,
    pub facts: &'a crate::pane_facts::PaneFactsStore,
    pub agents: &'a crate::shell_integration::AgentCommands,
    pub env: Option<&'a crate::env_vars::EnvVarStore>,
    pub hook_env: Option<crate::pty_manager::HookEnv>,
    pub events: &'a Events,
    pub clients: &'a dyn HostClients,
    pub files: &'a crate::file_watcher::FileWatcher,
    pub git: &'a crate::git_scheduler::GitScheduler,
    pub worktrees: &'a crate::worktree_watcher::WorktreeWatcher,
    pub search: &'a crate::search::SearchManager,
    pub prompt_actions: &'a crate::prompt_actions::PromptActionStore,
    pub handles: &'a crate::agent_names::HandleReservations,
    /// Once per process: the first Window's start provisions hooks and the
    /// skill; the rest find it done.
    pub hooks_guard: &'a crate::agent_hooks::StartupProvisionGuard,
    pub skill_guard: &'a crate::agent_skills::SkillStartupGuard,
    /// Agent control: the requests waiting on a Window's answer, and who
    /// waits on whom (`control_host.rs`).
    pub pending: &'a crate::control_protocol::PendingRequests,
    pub waits: &'a crate::control_protocol::WaitGraph,
}

fn bad_args(command: &str, e: serde_json::Error) -> AbundioError {
    AbundioError::InvalidOperation(format!("{command}: bad arguments: {e}"))
}

fn args<T: DeserializeOwned>(command: &str, args: Value) -> Result<T, AbundioError> {
    // `invoke` with no arguments sends nothing at all.
    let args = if args.is_null() { Value::Object(Default::default()) } else { args };
    serde_json::from_value(args).map_err(|e| bad_args(command, e))
}

fn json<T: Serialize>(v: T) -> Result<Value, AbundioError> {
    serde_json::to_value(v).map_err(|e| AbundioError::InvalidOperation(e.to_string()))
}

/// The arguments of one command, as a struct read from the Window's camelCase
/// keys: `a!(command, args, { pty_id: String, cols: u16 })`.
macro_rules! a {
    ($cmd:expr, $args:expr, { $($name:ident : $ty:ty),* $(,)? }) => {{
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        #[allow(dead_code)]
        struct A { $($name: $ty),* }
        let a: A = args($cmd, $args)?;
        a
    }};
}

/// The Windows to tell of a change to the Tabs of a Workspace of
/// `profile_id`: every one showing that Profile but `origin`, which made the
/// change itself (`None`: the Host did; tell them all).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TabsChanged {
    workspace_id: String,
    tabs: Vec<Tab>,
}

pub fn send_tabs_changed(
    workspaces: &WorkspaceStore,
    profiles: &HashMap<String, String>,
    events: &Events,
    origin: Option<&ClientId>,
    workspace_id: &str,
    profile_id: &str,
) {
    let nobody = ClientId(String::new());
    let targets = crate::layout_store::broadcast_targets(profiles, profile_id, origin.unwrap_or(&nobody));
    if targets.is_empty() {
        return;
    }
    let tabs = match workspaces.list_tabs(workspace_id) {
        Ok(tabs) => tabs,
        Err(e) => {
            log::warn!("[tabs] cannot list {workspace_id}'s Tabs to send: {e}");
            return;
        }
    };
    let payload = TabsChanged { workspace_id: workspace_id.to_string(), tabs };
    for client in targets {
        events.to_client(&client, "tabs-changed", &payload);
    }
}

/// The Profile's other Windows (on a Host: those of other apps too), which
/// must hear what `client` changed in the Profile's shared state (phase 9).
fn others_on_profile(host: &Host, client: &ClientId, profile_id: &str) -> Vec<ClientId> {
    crate::layout_store::broadcast_targets(&host.clients.profiles(), profile_id, client)
}

/// The Profile's Workspaces changed (made, renamed, moved, deleted): its
/// other Windows read the list again.
fn workspaces_changed(host: &Host, client: &ClientId, profile_id: &str) {
    for target in others_on_profile(host, client, profile_id) {
        host.events.to_client(&target, "workspaces-changed", serde_json::json!({ "profileId": profile_id }));
    }
}

/// Run one host command for `client`. `None` when the command is not one of
/// these.
pub fn dispatch(host: &Host, client: &ClientId, command: &str, raw: Value) -> Option<Result<Value, AbundioError>> {
    run(host, client, command, raw).transpose()
}

fn run(host: &Host, client: &ClientId, command: &str, raw: Value) -> Result<Option<Value>, AbundioError> {
    use crate::file_explorer as fe;
    use crate::orchestrator as orch;
    use crate::prompt_actions as pa;
    use crate::git_commands as gc;
    use crate::pty_manager::PtyManager;
    use crate::worktree_commands as wt;
    let c = command;
    let out = match command {
        // ── Terminals ──
        "pty_spawn" => json(pty_spawn(host, client, args(c, raw)?)?)?,
        "pty_write" => {
            let a = a!(c, raw, { pty_id: String, data: String });
            // Typing from a Client whose view has another size: the PTY
            // takes its size first (last-actor sizing, phase 9).
            if let Some((cols, rows)) = host.ptys.sizes.typed(client.as_str(), &a.pty_id) {
                host.ptys.resize(&a.pty_id, cols, rows)?;
            }
            // As typed in xterm.js: UTF-8 text.
            json(host.ptys.write(&a.pty_id, a.data.into_bytes())?)?
        }
        "pty_resize" => {
            let a = a!(c, raw, { pty_id: String, cols: u16, rows: u16 });
            match host.ptys.sizes.resized(client.as_str(), &a.pty_id, (a.cols, a.rows)) {
                Some((cols, rows)) => json(host.ptys.resize(&a.pty_id, cols, rows)?)?,
                None => json(())?,
            }
        }
        "pty_kill" => json(host.ptys.kill(&a!(c, raw, { pty_id: String }).pty_id)?)?,
        "pty_alive" => json(host.ptys.alive(&a!(c, raw, { pty_ids: Vec<String> }).pty_ids))?,
        "pty_redraw" => json(host.ptys.redraw(&a!(c, raw, { pty_id: String }).pty_id)?)?,
        "pty_read_screen" => {
            let a = a!(c, raw, { pty_id: String, visible: bool, lines: Option<usize> });
            json(host.ptys.read_screen(&a.pty_id, a.visible, a.lines)?)?
        }
        "pty_set_scrollback" => {
            host.ptys.set_scrollback(a!(c, raw, { lines: usize }).lines);
            Value::Null
        }
        "pty_read_log" => json(PtyManager::read_log(&a!(c, raw, { log_id: String }).log_id)?)?,
        "pty_delete_log" => json(PtyManager::delete_log(&a!(c, raw, { log_id: String }).log_id)?)?,
        "pty_cleanup_stale_logs" => {
            json(PtyManager::cleanup_stale_logs(&a!(c, raw, { pane_ids: Vec<String> }).pane_ids)?)?
        }
        "pty_write_snapshot" => {
            let a = a!(c, raw, { pane_id: String, data: String });
            json(PtyManager::write_snapshot(&a.pane_id, &a.data)?)?
        }
        "pty_read_snapshot" => json(PtyManager::read_snapshot(&a!(c, raw, { pane_id: String }).pane_id)?)?,
        "default_shell" => json(crate::shell_env::default_shell())?,
        "list_available_shells" => json(crate::shell_env::list_available_shells())?,

        // ── Status ──
        "status_apply" => {
            let a = a!(c, raw, { ops: Vec<crate::status_store::StatusOp> });
            let config = host.status.config();
            let updates: Vec<_> = a.ops.into_iter().filter_map(|op| host.status.run_op(client, op, &config)).collect();
            json(updates)?
        }
        "status_byte_threshold_set" => {
            host.status.set_byte_threshold(a!(c, raw, { bytes: i64 }).bytes);
            Value::Null
        }
        "agent_commands_set" => {
            let a = a!(c, raw, {
                list: Vec<crate::shell_integration::AgentCommand>,
                hooks_enabled: Option<bool>,
                declined: Option<Vec<String>>,
            });
            host.agents.set(a.list);
            if let Some(hooks) = a.hooks_enabled {
                host.agents.set_offer_settings(hooks, &a.declined.unwrap_or_default());
            }
            Value::Null
        }
        // ── Watch offer (docs/plans/watch-offer.md) ──
        "watch_offer_close" => {
            // `watched`: the answer was Enable, so the other panes running
            // the Agent are offered a restart instead.
            let a = a!(c, raw, { agent_id: String, snooze: bool, watched: Option<bool> });
            if a.snooze {
                host.agents.snooze(&a.agent_id);
            }
            host.events.broadcast(
                crate::shell_integration::WATCH_OFFER_CLOSED_EVENT,
                serde_json::json!({ "agentId": a.agent_id, "watched": a.watched.unwrap_or(false) }),
            );
            Value::Null
        }
        "pane_facts_report" => {
            host.facts.apply(a!(c, raw, { reports: Vec<crate::pane_facts::PaneFactsReport> }).reports);
            Value::Null
        }

        // ── Layouts and Tabs ──
        "layout_apply" => {
            let a = a!(c, raw, { tab_id: String, ops: Vec<crate::layout_ops::LayoutOp> });
            let applied = host.layouts.apply(host.workspaces, &a.tab_id, &a.ops, &|id| host.ptys.is_live(id))?;
            if applied.changed {
                let profiles = host.clients.profiles();
                for target in crate::layout_store::broadcast_targets(&profiles, &applied.profile_id, client) {
                    host.events.to_client(&target, "layout-changed", &applied.state);
                }
            }
            json(applied.state)?
        }
        "tab_list" => json(host.workspaces.list_tabs(&a!(c, raw, { workspace_id: String }).workspace_id)?)?,
        "tab_create" => {
            let a = a!(c, raw, { workspace_id: String, name: String });
            let tab = host.workspaces.create_tab(&a.workspace_id, &a.name)?;
            if let Some(profile_id) = host.workspaces.profile_of(&a.workspace_id)? {
                tabs_changed(host, client, &a.workspace_id, &profile_id);
            }
            json(tab)?
        }
        "tab_delete" => {
            let id = a!(c, raw, { id: String }).id;
            host.layouts.forget(&id);
            let owner = host.workspaces.tab_owner(&id)?;
            host.workspaces.delete_tab(&id)?;
            if let Some((workspace_id, profile_id)) = owner {
                tabs_changed(host, client, &workspace_id, &profile_id);
            }
            Value::Null
        }
        "tab_update" => {
            let a = a!(c, raw, { id: String, updates: TabUpdate });
            // A layout written here bypasses the layout store: let it read afresh.
            if a.updates.layout_json.is_some() {
                host.layouts.forget(&a.id);
            }
            let tab_level = a.updates.name.is_some() || a.updates.position.is_some();
            host.workspaces.update_tab(&a.id, a.updates)?;
            if tab_level {
                if let Some((workspace_id, profile_id)) = host.workspaces.tab_owner(&a.id)? {
                    tabs_changed(host, client, &workspace_id, &profile_id);
                }
            }
            Value::Null
        }

        // ── Workspaces ──
        "workspace_list" => json(host.workspaces.list(&a!(c, raw, { profile_id: String }).profile_id)?)?,
        "workspace_create" => {
            let a = a!(c, raw, { name: String, root_folder: String, profile_id: String });
            // One folder per Profile, never an Orchestrator folder (GLOSSARY.md).
            crate::workspace_folders::enforce(&folder_check(host, &a.root_folder, &a.profile_id, None)?)?;
            let made = host.workspaces.create(&a.name, &a.root_folder, &a.profile_id)?;
            workspaces_changed(host, client, &a.profile_id);
            json(made)?
        }
        "workspace_update" => {
            let a = a!(c, raw, { id: String, updates: WorkspaceUpdate });
            if let Some(folder) = &a.updates.root_folder {
                if let Some(profile_id) = host.workspaces.profile_of(&a.id)? {
                    crate::workspace_folders::enforce(&folder_check(host, folder, &profile_id, Some(&a.id))?)?;
                }
            }
            host.workspaces.update(&a.id, a.updates)?;
            if let Some(profile_id) = host.workspaces.profile_of(&a.id)? {
                workspaces_changed(host, client, &profile_id);
            }
            json(())?
        }
        "workspace_delete" => {
            let id = a!(c, raw, { id: String }).id;
            let profile_id = host.workspaces.profile_of(&id)?;
            host.workspaces.delete(&id)?;
            if let Some(profile_id) = profile_id {
                workspaces_changed(host, client, &profile_id);
            }
            json(())?
        }
        "workspace_folder_check" => {
            let a = a!(c, raw, { root_folder: String, profile_id: String });
            json(folder_check(host, &a.root_folder, &a.profile_id, None)?)?
        }
        "workspace_missing_folders" => {
            let rows = host.workspaces.folder_rows(&a!(c, raw, { profile_id: String }).profile_id)?;
            json(crate::workspace_store::missing_ids(rows, |p| std::path::Path::new(p).is_dir()))?
        }
        "workspace_reorder" => {
            let ids = a!(c, raw, { ids: Vec<String> }).ids;
            host.workspaces.reorder_workspaces(&ids)?;
            if let Some(profile_id) = ids.first().map(|id| host.workspaces.profile_of(id)).transpose()?.flatten() {
                workspaces_changed(host, client, &profile_id);
            }
            json(())?
        }
        "workspace_restore_set" => json(host.workspaces.restore_set(&a!(c, raw, { profile_id: String }).profile_id)?)?,
        "workspace_set_restore_active" => {
            let a = a!(c, raw, { profile_id: String, id: Option<String> });
            json(host.workspaces.set_restore_active(&a.profile_id, a.id.as_deref())?)?
        }
        "workspace_set_restore_opened" => {
            let a = a!(c, raw, { id: String, opened: bool });
            json(host.workspaces.set_restore_opened(&a.id, a.opened)?)?
        }
        // ── Files ──
        "fs_list_dir" => json(fe::fs_list_dir(a!(c, raw, { path: String }).path)?)?,
        "fs_home_dir" => json(fe::fs_home_dir()?)?,
        "fs_list_files" => {
            let a = a!(c, raw, { root_path: String, max_files: Option<usize> });
            json(fe::fs_list_files(a.root_path, a.max_files)?)?
        }
        "fs_index_workspace_files" => {
            json(fe::fs_index_workspace_files(a!(c, raw, { root_path: String }).root_path)?)?
        }
        "fs_read_file" => json(fe::fs_read_file(a!(c, raw, { path: String }).path)?)?,
        "fs_write_file" => {
            let a = a!(c, raw, { path: String, content: String });
            json(fe::fs_write_file(a.path, a.content)?)?
        }
        "fs_file_exists" => json(fe::fs_file_exists(a!(c, raw, { path: String }).path)?)?,
        "fs_create_file" => json(fe::fs_create_file(a!(c, raw, { path: String }).path)?)?,
        "fs_create_folder" => json(fe::fs_create_folder(a!(c, raw, { path: String }).path)?)?,
        "fs_rename" => {
            let a = a!(c, raw, { from: String, to: String });
            json(fe::fs_rename(a.from, a.to)?)?
        }
        "fs_delete" => json(fe::fs_delete(a!(c, raw, { path: String }).path)?)?,
        "fs_search" => {
            let params = a!(c, raw, { params: crate::search::SearchQuery }).params;
            json(crate::search::fs_search(host.search, host.events, client, params)?)?
        }
        "fs_search_cancel" => {
            json(crate::search::fs_search_cancel(host.search, &a!(c, raw, { search_id: String }).search_id)?)?
        }
        "fs_watch_start" => {
            let root = a!(c, raw, { root_path: String }).root_path;
            host.files.start_watching(host.events.clone(), client.as_str(), &root)?;
            // A start sent just before the Window closed would hold a watch
            // nothing releases: let go if the Window is already gone.
            if !host.clients.is_alive(client) {
                host.files.stop_watching(client.as_str(), &root);
            }
            Value::Null
        }
        "fs_watch_stop" => {
            host.files.stop_watching(client.as_str(), &a!(c, raw, { root_path: String }).root_path);
            Value::Null
        }

        // ── Git ──
        "git_changed_files" => {
            let a = a!(c, raw, { cwd: String, base_branch: Option<String> });
            json(gc::git_changed_files(a.cwd, a.base_branch)?)?
        }
        "git_repo_slug" => json(gc::git_repo_slug(a!(c, raw, { cwd: String }).cwd)?)?,
        "git_snapshot_worktree" => json(gc::git_snapshot_worktree(a!(c, raw, { cwd: String }).cwd)?)?,
        "git_diff_trees" => {
            let a = a!(c, raw, { cwd: String, start_oid: String, end_oid: String });
            json(gc::git_diff_trees(a.cwd, a.start_oid, a.end_oid)?)?
        }
        "git_fetch_bundle" => {
            let a = a!(c, raw, { cwd: String, base_branch: Option<String> });
            json(gc::git_fetch_bundle(a.cwd, a.base_branch)?)?
        }
        "git_file_diff" => {
            let a = a!(c, raw, { cwd: String, file_path: String, section: String, base_branch: Option<String> });
            json(gc::git_file_diff(a.cwd, a.file_path, a.section, a.base_branch)?)?
        }
        "git_commit_files" => {
            let a = a!(c, raw, { cwd: String, oid: String });
            json(gc::git_commit_files(a.cwd, a.oid)?)?
        }
        "git_commit_file_diff" => {
            let a = a!(c, raw, { cwd: String, oid: String, file_path: String });
            json(gc::git_commit_file_diff(a.cwd, a.oid, a.file_path)?)?
        }
        "git_conflict_file" => {
            let a = a!(c, raw, { cwd: String, file_path: String });
            json(gc::git_conflict_file(a.cwd, a.file_path)?)?
        }
        "git_stage_path" => {
            let a = a!(c, raw, { cwd: String, file_path: String });
            json(gc::git_stage_path(a.cwd, a.file_path)?)?
        }
        "git_branch_info" => json(gc::git_branch_info(a!(c, raw, { cwd: String }).cwd)?)?,
        "git_status_fingerprint" => json(gc::git_status_fingerprint(a!(c, raw, { cwd: String }).cwd)?)?,
        "git_list_branches" => json(gc::git_list_branches(a!(c, raw, { cwd: String }).cwd)?)?,
        "git_workspaces_summary" => {
            json(gc::git_workspaces_summary(a!(c, raw, { requests: Vec<gc::WorkspaceGitRequest> }).requests))?
        }
        "git_scheduler_start" => {
            let a = a!(c, raw, { workspace_id: String, root_path: String, base_branch: Option<String> });
            host.git.start(host.events.clone(), client.as_str(), a.workspace_id.clone(), a.root_path, a.base_branch);
            // See `fs_watch_start`.
            if !host.clients.is_alive(client) {
                host.git.stop(client.as_str(), &a.workspace_id);
            }
            Value::Null
        }
        "git_fetch_upstream" => {
            let a = a!(c, raw, { cwd: String, background: Option<bool> });
            let outcome =
                crate::git_upstream::fetch_upstream(&a.cwd, a.background.unwrap_or(false))?;
            if let crate::git_upstream::FetchOutcome::Fetched { common_dir } = &outcome {
                host.git.refresh_repo(common_dir);
            }
            json(outcome)?
        }
        "git_pull_ff" => {
            let cwd = a!(c, raw, { cwd: String }).cwd;
            let outcome = crate::git_upstream::pull_ff(&cwd)?;
            // The fetch may have moved every worktree's counts, and the pull
            // moved this one's HEAD.
            if let Some(common) = crate::git_upstream::common_dir(&cwd) {
                host.git.refresh_repo(&common);
            }
            json(outcome)?
        }
        "git_scheduler_stop" => {
            host.git.stop(client.as_str(), &a!(c, raw, { workspace_id: String }).workspace_id);
            Value::Null
        }

        // ── Worktrees ──
        "list_repo_worktrees" => json(wt::list_repo_worktrees(a!(c, raw, { cwd: String }).cwd)?)?,
        "worktree_add" => {
            let a = a!(c, raw, { primary_cwd: String, branch: String, path: String });
            json(wt::worktree_add(a.primary_cwd, a.branch, a.path)?)?
        }
        "worktree_remove" => {
            let a = a!(c, raw, { primary_cwd: String, worktree_path: String });
            json(wt::worktree_remove(a.primary_cwd, a.worktree_path)?)?
        }
        "worktree_dirty" => json(wt::worktree_dirty(a!(c, raw, { cwd: String }).cwd)?)?,
        "worktree_watch_set" => {
            let dirs = a!(c, raw, { common_dirs: Vec<String> }).common_dirs;
            host.worktrees.set_watched(host.events, client.as_str(), dirs);
            Value::Null
        }
        // ── Environment variables ──
        c if c.starts_with("env_") => return env(host, c, raw).map(Some),

        // ── Agents ──
        "list_installed_agent_commands" => {
            json(crate::agent_registry::list_installed_agent_commands(a!(c, raw, { commands: Vec<String> }).commands))?
        }
        "agents_path_is_resolved" => json(crate::agent_registry::agents_path_is_resolved())?,
        "agents_claim_seeding" => json(crate::agent_registry::agents_claim_seeding(host.workspaces)?)?,
        "agents_commit_seeding" => json(crate::agent_registry::agents_commit_seeding(host.workspaces)?)?,
        "agent_hook_status" => json(crate::agent_hooks::agent_hook_status()?)?,
        "agent_hooks_provision" => {
            let a = a!(c, raw, { enabled: bool, enabled_agents: Vec<String> });
            json(crate::agent_hooks::provision(a.enabled, &a.enabled_agents)?)?
        }
        "agent_hooks_provision_startup" => {
            let a = a!(c, raw, { enabled: bool, enabled_agents: Vec<String> });
            if host.hooks_guard.claim() {
                // The invisible path: leave a breadcrumb where a dev can see it.
                log::info!("startup hook provisioning: enabled={}, agents={:?}", a.enabled, a.enabled_agents);
                if let Err(e) = crate::agent_hooks::provision(a.enabled, &a.enabled_agents) {
                    log::warn!("startup hook provisioning failed: {e}");
                    return Err(e);
                }
            }
            Value::Null
        }
        "ensure_agent_hooks" => {
            let a = a!(c, raw, { agent_id: String, enabled: bool });
            json(crate::agent_hooks::ensure_agent_hooks(&a.agent_id, a.enabled)?)?
        }
        "agent_skill_provision" => {
            let a = a!(c, raw, { enabled: bool, enabled_agents: Vec<String> });
            let paths = crate::agent_skills::SkillPaths::for_user()?;
            json(crate::agent_skills::provision_at(&paths, a.enabled, &a.enabled_agents)?)?
        }
        "agent_skill_provision_startup" => {
            let a = a!(c, raw, { enabled: bool, enabled_agents: Vec<String> });
            if host.skill_guard.claim() {
                log::info!("startup skill provisioning: enabled={}", a.enabled);
                let paths = crate::agent_skills::SkillPaths::for_user()?;
                if let Err(e) = crate::agent_skills::provision_at(&paths, a.enabled, &a.enabled_agents) {
                    log::warn!("startup skill provisioning: {e}");
                    return Err(e);
                }
            }
            Value::Null
        }
        "agent_skill_status" => json(crate::agent_skills::status_at(&crate::agent_skills::SkillPaths::for_user()?))?,
        "agent_handle_check" => {
            let a = a!(c, raw, { workspace_id: String, pane_id: String, handle: String });
            json(host.handles.check(host.workspaces, &a.workspace_id, &a.pane_id, &a.handle)?)?
        }
        "agent_handle_default" => {
            let a = a!(c, raw, { workspace_id: String, pane_id: String, prefix: Option<String> });
            json(host.handles.take_default(host.workspaces, &a.workspace_id, &a.pane_id, a.prefix.as_deref())?)?
        }
        // ── Host settings (ADR-0064) ──
        "host_settings_get" => json(crate::host_settings::get(host.workspaces)?)?,
        "host_settings_set" => {
            let settings = a!(c, raw, { settings: crate::host_settings::HostSettings }).settings;
            crate::host_settings::set(host.workspaces, &settings)?;
            settings.apply_to(host.agents);
            if let Some(n) = settings.scrollback {
                host.ptys.set_scrollback(n);
            }
            // Every Client of this Host, the one that changed them too: its
            // other Windows and Settings follow.
            host.events.broadcast(crate::host_settings::CHANGED_EVENT, &settings);
            Value::Null
        }
        "agent_control_enabled" => json(crate::control_protocol::enabled(host.workspaces))?,
        "agent_control_set_enabled" => {
            let on = a!(c, raw, { enabled: bool }).enabled;
            json(host.workspaces.set_setting(crate::control_protocol::SETTING_KEY, if on { "1" } else { "0" })?)?
        }
        "agent_control_pane_numbers" => {
            let a = a!(c, raw, { workspace_id: String, pane_ids: Vec<String> });
            json(host.workspaces.pane_numbers(&a.workspace_id, &a.pane_ids)?)?
        }
        "agent_control_pane_for_number" => {
            let a = a!(c, raw, { workspace_id: String, number: u32 });
            json(host.workspaces.pane_for_number(&a.workspace_id, a.number)?)?
        }

        // ── Prompt actions ──
        // The Orchestrator's suggested questions, on this computer (Prompt
        // actions are this computer's, ADR-0064), whatever the Orchestrator's
        // Host.
        "prompt_actions_seed_orchestrator" => {
            if host.prompt_actions.seed_orchestrator_actions()? {
                crate::prompt_actions::broadcast(host.events);
            }
            Value::Null
        }
        "prompt_actions_list" => json(pa::prompt_actions_list(host.prompt_actions)?)?,
        "prompt_action_create" => {
            let action = a!(c, raw, { action: pa::PromptActionCreate }).action;
            json(pa::prompt_action_create(host.events, host.prompt_actions, action)?)?
        }
        "prompt_action_update" => {
            let a = a!(c, raw, { id: String, updates: pa::PromptActionUpdate });
            json(pa::prompt_action_update(host.events, host.prompt_actions, a.id, a.updates)?)?
        }
        "prompt_action_delete" => {
            json(pa::prompt_action_delete(host.events, host.prompt_actions, a!(c, raw, { id: String }).id)?)?
        }
        "prompt_actions_reorder" => {
            json(pa::prompt_actions_reorder(host.events, host.prompt_actions, a!(c, raw, { ids: Vec<String> }).ids)?)?
        }

        // ── Notes and statistics ──
        "note_get" => json(host.workspaces.get_note(&a!(c, raw, { workspace_id: String }).workspace_id)?)?,
        "note_set" => {
            let a = a!(c, raw, { workspace_id: String, content: String });
            host.workspaces.set_note(&a.workspace_id, &a.content)?;
            if let Some(profile_id) = host.workspaces.profile_of(&a.workspace_id)? {
                for target in others_on_profile(host, client, &profile_id) {
                    host.events.to_client(
                        &target,
                        "note-changed",
                        serde_json::json!({ "workspaceId": a.workspace_id, "content": a.content }),
                    );
                }
            }
            json(())?
        }
        "telemetry_record_turn" => {
            json(host.workspaces.record_agent_turn(&a!(c, raw, { turn: crate::workspace_store::AgentTurnRecord }).turn)?)?
        }
        "telemetry_list_turns" => {
            let a = a!(c, raw, { profile_id: String, from_ms: i64, to_ms: i64 });
            json(host.workspaces.list_agent_turns(&a.profile_id, a.from_ms, a.to_ms)?)?
        }
        "telemetry_totals" => {
            let a = a!(c, raw, { profile_id: String, from_ms: i64, to_ms: i64 });
            json(host.workspaces.agent_turn_totals(&a.profile_id, a.from_ms, a.to_ms)?)?
        }
        "telemetry_buckets" => {
            let a = a!(c, raw, { profile_id: String, from_ms: i64, to_ms: i64, bucket: String, group_by: String });
            json(host.workspaces.agent_turn_buckets(
                &a.profile_id,
                a.from_ms,
                a.to_ms,
                crate::workspace_store::Bucket::parse(&a.bucket)?,
                crate::workspace_store::GroupBy::parse(&a.group_by)?,
            )?)?
        }

        // ── The Orchestrator ──
        "orchestrator_ensure" => {
            let profile_id = a!(c, raw, { profile_id: String }).profile_id;
            json(orch::orchestrator_ensure(host.events, host.workspaces, host.prompt_actions, profile_id)?)?
        }
        "orchestrator_folder_get" => {
            json(orch::orchestrator_folder_get(host.workspaces, a!(c, raw, { profile_id: String }).profile_id)?)?
        }
        "orchestrator_folder_set" => {
            let a = a!(c, raw, { profile_id: String, path: Option<String> });
            json(orch::orchestrator_folder_set(host.events, host.workspaces, a.profile_id, a.path)?)?
        }
        "orchestrator_agent_get" => {
            json(orch::orchestrator_agent_get(host.workspaces, a!(c, raw, { profile_id: String }).profile_id)?)?
        }
        "orchestrator_agent_set" => {
            let a = a!(c, raw, { profile_id: String, agent_id: Option<String> });
            json(orch::orchestrator_agent_set(host.workspaces, a.profile_id, a.agent_id)?)?
        }
        "orchestrator_tabs_list" => {
            json(orch::orchestrator_tabs_list(host.workspaces, a!(c, raw, { profile_id: String }).profile_id)?)?
        }
        "orchestrator_tab_add" => {
            let a = a!(c, raw, { profile_id: String, tab: crate::workspace_store::NewOrchestratorTab });
            json(orch::orchestrator_tab_add(host.workspaces, a.profile_id, a.tab)?)?
        }
        "orchestrator_tab_remove" => {
            let a = a!(c, raw, { profile_id: String, id: String });
            json(orch::orchestrator_tab_remove(host.workspaces, a.profile_id, a.id)?)?
        }
        "orchestrator_tab_select" => {
            let a = a!(c, raw, { profile_id: String, id: Option<String> });
            json(orch::orchestrator_tab_select(host.workspaces, a.profile_id, a.id)?)?
        }
        "orchestrator_tab_set_view" => {
            let a = a!(c, raw, { profile_id: String, id: String, view: crate::workspace_store::MarkdownView });
            json(orch::orchestrator_tab_set_view(host.workspaces, a.profile_id, a.id, a.view)?)?
        }
        "orchestrator_tab_set_pdf_position" => {
            let a = a!(c, raw, { profile_id: String, id: String, position: crate::pdf_position::PdfPosition });
            json(orch::orchestrator_tab_set_pdf_position(host.workspaces, a.profile_id, a.id, a.position)?)?
        }
        // ── Agent control: the Window's side of a call ──
        "agent_control_reply" => {
            let a = a!(c, raw, { id: String, reply: Value });
            // Only the Window the request was sent to may answer it.
            json(host.pending.reply_from(client.as_str(), &a.id, a.reply))?
        }
        "agent_control_pane_closed" => {
            // A pane closed: tell every Window (ADR-0055); its Spawned panes
            // may sit in Workspaces other Windows hold. Only a Window showing
            // a Profile holds panes.
            if host.clients.profiles().contains_key(client.as_str()) {
                let pane_id = a!(c, raw, { pane_id: String }).pane_id;
                host.events.broadcast("agent-control-pane-closed", serde_json::json!({ "paneId": pane_id }));
            }
            Value::Null
        }
        // ── Remote profiles (phase 7d): the Host's own Profiles ──
        "server_profile_list" => json(host.profiles.list()?)?,
        "server_profile_create" => {
            let profile = host.profiles.create(&a!(c, raw, { name: String }).name)?;
            host.events.broadcast("profiles-changed", ());
            json(profile)?
        }
        "server_profile_rename" => {
            let a = a!(c, raw, { id: String, name: String });
            let name = a.name.trim();
            if name.is_empty() {
                return Err(AbundioError::InvalidOperation("a Profile needs a name".into()));
            }
            host.profiles.update(&a.id, crate::profile_store::ProfileUpdate { name: Some(name.to_string()) })?;
            host.events.broadcast("profiles-changed", ());
            Value::Null
        }
        // Settings ▸ Profiles for a Host (phase 10d-3): never while a Window
        // shows it; its panes stop (here they outlive every Window), its
        // Workspaces go with it, never their folders.
        "server_profile_delete" => {
            let id = a!(c, raw, { id: String }).id;
            if host.clients.profiles().values().any(|p| p == &id) {
                return Err(AbundioError::InvalidOperation(
                    "a Window shows this Profile; close it there first".into(),
                ));
            }
            let workspaces: std::collections::HashSet<String> =
                host.workspaces.list(&id)?.into_iter().map(|w| w.workspace.id).collect();
            let orchestrator = host.workspaces.orchestrator_folder_of(&id).ok().flatten().filter(|f| {
                let rows = host.workspaces.all_folders().unwrap_or_default();
                !crate::workspace_folders::holds_work(&rows, std::path::Path::new(f))
            });
            host.profiles.delete(&id)?;
            for pty in host.ptys.ptys_of_workspaces(&workspaces) {
                let _ = host.ptys.kill(&pty);
            }
            if let Some(folder) = orchestrator {
                crate::orchestrator::forget_folder_at(&crate::app_paths::shared_root(), std::path::Path::new(&folder));
            }
            host.events.broadcast("profiles-changed", ());
            Value::Null
        }
        // Agent control for an Agent on the calling Client's computer
        // (ADR-0065): its answer as the `abundio` command would get it.
        "control_call" => {
            let a = a!(c, raw, { argv: Vec<String>, label: String, owner: String, request_id: Option<String> });
            let answer =
                crate::control_host::call_from_client(host, client, a.argv, &a.label, &a.owner, a.request_id);
            serde_json::json!({ "status": answer.status, "body": answer.body })
        }
        // An owner on the Client's computer closed (`owner`), or the Client
        // left the Profile (none): its panes here become ordinary.
        "control_owner_gone" => {
            let a = a!(c, raw, { owner: Option<String> });
            json(crate::control_host::owner_gone(host, client, a.owner.as_deref()))?
        }
        "control_cancel" => {
            let a = a!(c, raw, { owner: String, request_id: String });
            json(crate::control_host::cancel_from_client(host, client, &a.owner, &a.request_id))?
        }
        "client_profile_set" => {
            host.clients.set_profile(client, &a!(c, raw, { profile_id: String }).profile_id);
            Value::Null
        }
        _ => return Ok(None),
    };
    Ok(Some(out))
}

/// The Environment Bundle commands (ADR-0024). Plaintext still crosses only
/// one variable at a time (`env_vars_reveal`).
fn env(host: &Host, c: &str, raw: Value) -> Result<Value, AbundioError> {
    use crate::env_vars_commands as ev;
    if c == "env_retry_key" {
        return json(ev::env_retry_key());
    }
    let store = host
        .env
        .ok_or_else(|| AbundioError::InvalidOperation("environment variables are unavailable on this Host".into()))?;
    match c {
        "env_list" => {
            let a = a!(c, raw, { workspace_id: String, inherit_from_workspace_id: Option<String>, bundle: Option<String> });
            json(ev::env_list(store, a.workspace_id, a.inherit_from_workspace_id, a.bundle)?)
        }
        "env_bundle_create" => {
            let a = a!(c, raw, { workspace_id: String, inherit_from_workspace_id: Option<String>, name: String });
            json(ev::env_bundle_create(store, a.workspace_id, a.inherit_from_workspace_id, a.name)?)
        }
        "env_bundle_rename" => {
            let a = a!(c, raw, { workspace_id: String, from: String, to: String });
            json(ev::env_bundle_rename(store, a.workspace_id, a.from, a.to)?)
        }
        "env_bundle_set_injected" => {
            let a = a!(c, raw, { workspace_id: String, inherit_from_workspace_id: Option<String>, name: String });
            json(ev::env_bundle_set_injected(store, a.workspace_id, a.inherit_from_workspace_id, a.name)?)
        }
        "env_bundle_clear_injected" => {
            json(ev::env_bundle_clear_injected(store, a!(c, raw, { workspace_id: String }).workspace_id)?)
        }
        "env_injected_summary" => {
            let a = a!(c, raw, { workspace_id: String, inherit_from_workspace_id: Option<String> });
            json(ev::env_injected_summary(store, a.workspace_id, a.inherit_from_workspace_id)?)
        }
        "env_bundle_delete" => {
            let a = a!(c, raw, { workspace_id: String, name: String });
            json(ev::env_bundle_delete(store, a.workspace_id, a.name)?)
        }
        "env_vars_upsert" => {
            let a = a!(c, raw, {
                workspace_id: String, inherit_from_workspace_id: Option<String>, bundle: String, name: String, value: String,
            });
            json(ev::env_vars_upsert(store, a.workspace_id, a.inherit_from_workspace_id, a.bundle, a.name, a.value)?)
        }
        "env_vars_upsert_many" => {
            let a = a!(c, raw, {
                workspace_id: String, inherit_from_workspace_id: Option<String>, bundle: String,
                entries: Vec<crate::env_vars::EnvVarInput>,
            });
            json(ev::env_vars_upsert_many(store, a.workspace_id, a.inherit_from_workspace_id, a.bundle, a.entries)?)
        }
        "env_vars_delete" => {
            let a = a!(c, raw, { workspace_id: String, bundle: String, name: String });
            json(ev::env_vars_delete(store, a.workspace_id, a.bundle, a.name)?)
        }
        "env_vars_reveal" => {
            let a = a!(c, raw, {
                workspace_id: String, inherit_from_workspace_id: Option<String>, bundle: String, name: String,
            });
            json(ev::env_vars_reveal(store, a.workspace_id, a.inherit_from_workspace_id, a.bundle, a.name)?)
        }
        "env_vars_reorder" => {
            let a = a!(c, raw, { workspace_id: String, bundle: String, names: Vec<String> });
            json(ev::env_vars_reorder(store, a.workspace_id, a.bundle, a.names)?)
        }
        "env_export_to_path" => {
            let a = a!(c, raw, { workspace_id: String, bundle: String, workspace_name: String, path: String });
            json(ev::env_export_to_path(store, a.workspace_id, a.bundle, a.workspace_name, a.path)?)
        }
        _ => Err(AbundioError::NotFound(format!("no host command {c}"))),
    }
}

fn tabs_changed(host: &Host, client: &ClientId, workspace_id: &str, profile_id: &str) {
    send_tabs_changed(host.workspaces, &host.clients.profiles(), host.events, Some(client), workspace_id, profile_id);
}

fn folder_check(
    host: &Host,
    folder: &str,
    profile_id: &str,
    except: Option<&str>,
) -> Result<crate::workspace_folders::FolderCheck, AbundioError> {
    crate::workspace_folders::check(host.workspaces, &crate::app_paths::shared_root(), folder, profile_id, except)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnArgs {
    cwd: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
    shell: Option<String>,
    log_id: Option<String>,
    pty_id: Option<String>,
    workspace_name: Option<String>,
    window_label: Option<String>,
    // `workspace_id` selects whose injected Environment Bundle lands in the
    // child's environment. `inherit_from_workspace_id` is the main-worktree
    // Workspace, resolved by the frontend (`inheritSourceWorkspaceId`).
    workspace_id: Option<String>,
    inherit_from_workspace_id: Option<String>,
    // A **New task** launch (ADR-0042): the shell runs the Agent with the
    // Task prompt as a positional argument instead of a typed command.
    task: Option<crate::pty_manager::TaskLaunch>,
}

fn pty_spawn(host: &Host, client: &ClientId, a: SpawnArgs) -> Result<String, AbundioError> {
    // Never start a Workspace pane in the wrong folder (ADR-0053): refuse a
    // Missing folder, and start in the Workspace folder when only the pane's
    // own remembered folder is gone.
    let root = match a.workspace_id.as_deref() {
        Some(id) => host.workspaces.root_folder(id)?,
        None => None,
    };
    let cwd = crate::pty_manager::resolve_spawn_cwd(&a.cwd, root.as_deref(), |p| std::path::Path::new(p).is_dir())?;
    // No shell asked for: this Host's default (Host settings, ADR-0064).
    let host_shell = match a.shell {
        Some(_) => None,
        None => crate::host_settings::get(host.workspaces).ok().flatten().and_then(|s| s.shell_path),
    };
    let shell = a.shell.as_deref().or(host_shell.as_deref());
    let pty_id = host.ptys.spawn(
        crate::pty_manager::SpawnDeps {
            events: host.events.clone(),
            hook_env: host.hook_env.clone(),
            env_store: host.env,
        },
        client.as_str(),
        &cwd,
        a.command.as_deref(),
        shell,
        a.cols,
        a.rows,
        a.log_id.as_deref(),
        a.pty_id.as_deref(),
        a.workspace_name.as_deref(),
        a.window_label.as_deref(),
        a.workspace_id.as_deref(),
        a.inherit_from_workspace_id.as_deref(),
        a.task.as_ref(),
    )?;
    // The spawning Client's view has this size.
    host.ptys.sizes.resized(client.as_str(), &pty_id, (a.cols, a.rows));
    // A spawn the Window sent just before it closed can land after its
    // PTYs were killed with it: kill this one too if the Window is gone.
    if !host.clients.is_alive(client) {
        let _ = host.ptys.kill(&pty_id);
    }
    Ok(pty_id)
}

/// The commands that may block on the disk for long (a `stat` on a hung
/// mount): the desktop runs them off its async runtime.
pub fn may_block(command: &str) -> bool {
    matches!(command, "pty_spawn" | "workspace_missing_folders" | "workspace_create" | "workspace_update" | "workspace_folder_check")
        || command.starts_with("fs_")
        || command.starts_with("git_")
        || command.starts_with("gh_")
        || command.starts_with("worktree_")
        || command == "list_repo_worktrees"
        // The credential store can wait on a keychain prompt; a login shell's
        // PATH on its timeout; provisioning and the Orchestrator write files.
        || command.starts_with("env_")
        || command.starts_with("agent_hook")
        || command.starts_with("agent_skill")
        || command.starts_with("agents_")
        || command.starts_with("orchestrator_")
        || matches!(command, "ensure_agent_hooks" | "list_installed_agent_commands")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct Clients(HashMap<String, String>);
    impl HostClients for Clients {
        fn profiles(&self) -> HashMap<String, String> {
            self.0.clone()
        }
        fn is_alive(&self, _client: &ClientId) -> bool {
            true
        }
    }

    #[derive(Default)]
    struct Sink(Mutex<Vec<(String, String)>>);
    impl crate::event_sink::EventSink for Sink {
        fn broadcast_value(&self, event: &str, _payload: Value) {
            self.0.lock().unwrap().push(("*".into(), event.into()));
        }
        fn to_client_value(&self, client: &ClientId, event: &str, _payload: Value) {
            self.0.lock().unwrap().push((client.as_str().into(), event.into()));
        }
    }

    struct World {
        workspaces: WorkspaceStore,
        profiles: crate::profile_store::ProfileStore,
        ptys: crate::pty_manager::PtyManager,
        status: crate::status_store::StatusStore,
        layouts: crate::layout_store::LayoutStore,
        facts: crate::pane_facts::PaneFactsStore,
        agents: crate::shell_integration::AgentCommands,
        sink: Arc<Sink>,
        events: Events,
        clients: Clients,
        files: crate::file_watcher::FileWatcher,
        git: crate::git_scheduler::GitScheduler,
        worktrees: crate::worktree_watcher::WorktreeWatcher,
        search: crate::search::SearchManager,
        prompt_actions: crate::prompt_actions::PromptActionStore,
        handles: crate::agent_names::HandleReservations,
        hooks_guard: crate::agent_hooks::StartupProvisionGuard,
        skill_guard: crate::agent_skills::SkillStartupGuard,
        pending: crate::control_protocol::PendingRequests,
        waits: crate::control_protocol::WaitGraph,
    }

    const PID: &str = "00000000-0000-0000-0000-000000000001";

    fn world() -> World {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        let sink = Arc::new(Sink::default());
        let profiles_conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_migrations(&profiles_conn).unwrap();
        World {
            workspaces: WorkspaceStore::new(conn),
            profiles: crate::profile_store::ProfileStore::new(profiles_conn),
            ptys: crate::pty_manager::PtyManager::new(),
            status: Default::default(),
            layouts: crate::layout_store::LayoutStore::new(),
            facts: Default::default(),
            agents: Default::default(),
            events: sink.clone(),
            sink,
            clients: Clients(HashMap::from([("w1".into(), PID.into()), ("w2".into(), PID.into())])),
            files: crate::file_watcher::FileWatcher::new(Default::default()),
            git: crate::git_scheduler::GitScheduler::new(Default::default()),
            worktrees: crate::worktree_watcher::WorktreeWatcher::new(),
            search: crate::search::SearchManager::new(),
            prompt_actions: {
                let conn = rusqlite::Connection::open_in_memory().unwrap();
                crate::migrations::run_migrations(&conn).unwrap();
                crate::prompt_actions::PromptActionStore::new(conn)
            },
            handles: Default::default(),
            hooks_guard: Default::default(),
            skill_guard: Default::default(),
            pending: Default::default(),
            waits: Default::default(),
        }
    }

    fn call(w: &World, client: &str, command: &str, a: Value) -> Result<Value, AbundioError> {
        let host = Host {
            workspaces: &w.workspaces,
            profiles: &w.profiles,
            ptys: &w.ptys,
            status: &w.status,
            layouts: &w.layouts,
            facts: &w.facts,
            agents: &w.agents,
            env: None,
            hook_env: None,
            events: &w.events,
            clients: &w.clients,
            files: &w.files,
            git: &w.git,
            worktrees: &w.worktrees,
            search: &w.search,
            prompt_actions: &w.prompt_actions,
            handles: &w.handles,
            hooks_guard: &w.hooks_guard,
            skill_guard: &w.skill_guard,
            pending: &w.pending,
            waits: &w.waits,
        };
        dispatch(&host, &ClientId::from(client), command, a).expect("a host command")
    }

    /// ADR-0065: a Client carries an Agent control call for an Agent on its
    /// own computer; it reaches the Profile that Client shows, while this
    /// Host's Agent control is on.
    #[test]
    fn a_client_carries_agent_control_for_an_agent_on_its_computer() {
        let w = world();
        let run = |client: &str, argv: &[&str]| {
            let v = call(
                &w,
                client,
                "control_call",
                serde_json::json!({ "argv": argv, "label": "Agent One@laptop", "owner": "pane-1" }),
            )
            .unwrap();
            (v["status"].as_u64().unwrap(), v["body"].as_str().unwrap().to_string())
        };
        // No Workspaces yet: nothing stands for the caller's own.
        assert_eq!(run("w1", &["workspace", "list"]).0, 409);
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        call(&w, "w1", "workspace_create", serde_json::json!({ "name": "App", "rootFolder": folder, "profileId": PID })).unwrap();
        let (status, body) = run("w1", &["workspace", "list"]);
        assert_eq!(status, 200, "{body}");
        assert!(body.contains("App"), "{body}");
        // A Workspace of the Profile is named by this Host's names.
        assert_eq!(run("w1", &["--workspace", "Nope", "workspace", "list"]).0, 409);
        // A Client that shows no Profile here reaches nothing.
        let (status, body) = run("w9", &["workspace", "list"]);
        assert_eq!(status, 409);
        assert!(body.contains("no_profile"), "{body}");
        // This Host's switch governs its panes whoever calls.
        w.workspaces.set_setting(crate::control_protocol::SETTING_KEY, "0").unwrap();
        assert_eq!(run("w1", &["workspace", "list"]).0, 403);
    }

    /// ADR-0065: when the owner on the Client's computer closes, or the
    /// Client leaves, the panes it owns here become ordinary.
    #[test]
    fn a_clients_owner_going_releases_its_panes_here() {
        let w = world();
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        let ws = call(&w, "w1", "workspace_create", serde_json::json!({ "name": "App", "rootFolder": folder, "profileId": PID })).unwrap();
        let tab = call(&w, "w1", "tab_create", serde_json::json!({ "workspaceId": ws["id"], "name": "T" })).unwrap();
        let tab_id = tab["id"].as_str().unwrap();
        let layout = serde_json::json!({ "type": "split", "id": "s", "direction": "horizontal", "ratio": 0.5,
            "first": { "type": "terminal", "id": "a", "ptyId": "", "spawnedBy": "outside:w1:p9" },
            "second": { "type": "terminal", "id": "b", "ptyId": "", "spawnedBy": "outside:w1:p7" } });
        w.workspaces.set_tab_layout(tab_id, &layout.to_string()).unwrap();
        // Written behind the layout store's back: it reads it again.
        w.layouts.forget(tab_id);
        let spawned = |id: &str| {
            let t = w.workspaces.list_tabs(ws["id"].as_str().unwrap()).unwrap();
            let t = t.iter().find(|t| t.id == tab_id).unwrap();
            let tree: Value = serde_json::from_str(&t.layout_json).unwrap();
            let node = if id == "a" { &tree["first"] } else { &tree["second"] };
            node.get("spawnedBy").cloned()
        };
        assert_eq!(call(&w, "w1", "control_owner_gone", serde_json::json!({ "owner": "p9" })).unwrap(), 1);
        assert_eq!(spawned("a"), None);
        assert_eq!(spawned("b"), Some(Value::String("outside:w1:p7".into())));
        // Another Client's owner leaving changes nothing of w1's.
        assert_eq!(call(&w, "w2", "control_owner_gone", serde_json::json!({})).unwrap(), 0);
        // w1 leaving releases the rest.
        assert_eq!(call(&w, "w1", "control_owner_gone", serde_json::json!({})).unwrap(), 1);
        assert_eq!(spawned("b"), None);
    }

    #[test]
    fn runs_workspace_and_tab_commands_and_tells_the_other_windows() {
        let w = world();
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        let ws = call(&w, "w1", "workspace_create", serde_json::json!({ "name": "W", "rootFolder": folder, "profileId": PID })).unwrap();
        let ws_id = ws["id"].as_str().unwrap().to_string();
        // A second Workspace on the same folder is refused.
        let again = call(&w, "w1", "workspace_create", serde_json::json!({ "name": "X", "rootFolder": folder, "profileId": PID }));
        assert!(again.is_err());

        // The Profile's other Window hears of the new Workspace (phase 9).
        assert_eq!(*w.sink.0.lock().unwrap(), vec![("w2".to_string(), "workspaces-changed".to_string())]);
        w.sink.0.lock().unwrap().clear();

        let tab = call(&w, "w1", "tab_create", serde_json::json!({ "workspaceId": ws_id, "name": "T" })).unwrap();
        assert_eq!(tab["name"], "T");
        assert_eq!(*w.sink.0.lock().unwrap(), vec![("w2".to_string(), "tabs-changed".to_string())]);
        w.sink.0.lock().unwrap().clear();
        // A rename, a note and a delete reach it too; never the Window that
        // made them.
        call(&w, "w1", "workspace_update", serde_json::json!({ "id": ws_id, "updates": { "name": "Renamed" } })).unwrap();
        call(&w, "w1", "note_set", serde_json::json!({ "workspaceId": ws_id, "content": "remember" })).unwrap();
        call(&w, "w1", "workspace_delete", serde_json::json!({ "id": ws_id })).unwrap();
        let heard: Vec<(String, String)> = w.sink.0.lock().unwrap().clone();
        assert_eq!(
            heard,
            [("w2", "workspaces-changed"), ("w2", "note-changed"), ("w2", "workspaces-changed")]
                .map(|(a, b)| (a.to_string(), b.to_string()))
        );
        let listed = call(&w, "w2", "workspace_list", serde_json::json!({ "profileId": PID })).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 0, "deleted above");
        assert_eq!(call(&w, "w1", "default_shell", Value::Null).unwrap().as_str().map(|s| !s.is_empty()), Some(true));
    }

    /// Settings ▸ Profiles for a Host (phase 10d-3): rename, and delete
    /// refused while a Window shows it.
    #[test]
    fn a_hosts_profiles_are_renamed_and_deleted_but_never_one_a_window_shows() {
        let w = world();
        let other = call(&w, "w1", "server_profile_create", serde_json::json!({ "name": "Other" })).unwrap();
        let other_id = other["id"].as_str().unwrap().to_string();
        call(&w, "w1", "server_profile_rename", serde_json::json!({ "id": other_id, "name": " Lab " })).unwrap();
        let names: Vec<String> = call(&w, "w1", "server_profile_list", Value::Null)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"Lab".to_string()), "{names:?}");
        assert!(call(&w, "w1", "server_profile_rename", serde_json::json!({ "id": other_id, "name": "  " })).is_err());
        // w1 and w2 show PID: refused.
        let refused = call(&w, "w1", "server_profile_delete", serde_json::json!({ "id": PID })).unwrap_err();
        assert!(refused.to_string().contains("a Window shows this Profile"), "{refused}");
        // Nobody shows the other one: gone.
        call(&w, "w1", "server_profile_delete", serde_json::json!({ "id": other_id })).unwrap();
        let left = call(&w, "w1", "server_profile_list", Value::Null).unwrap();
        assert!(!left.to_string().contains(&other_id));
    }

    #[test]
    fn status_answers_go_to_the_asking_window() {
        let w = world();
        let out = call(
            &w,
            "w1",
            "status_apply",
            serde_json::json!({ "ops": [{ "op": "init", "ptyId": "p", "mode": "agent" }] }),
        )
        .unwrap();
        assert_eq!(out[0]["ptyId"], "p");
        assert_eq!(w.status.owner("p").unwrap().as_str(), "w1");
    }

    #[test]
    fn says_what_is_wrong_with_bad_arguments_and_leaves_others_alone() {
        let w = world();
        let e = call(&w, "w1", "pty_resize", serde_json::json!({ "ptyId": "p" })).unwrap_err();
        assert!(e.to_string().contains("pty_resize: bad arguments"), "{e}");
        let host = Host {
            workspaces: &w.workspaces,
            profiles: &w.profiles,
            ptys: &w.ptys,
            status: &w.status,
            layouts: &w.layouts,
            facts: &w.facts,
            agents: &w.agents,
            env: None,
            hook_env: None,
            events: &w.events,
            clients: &w.clients,
            files: &w.files,
            git: &w.git,
            worktrees: &w.worktrees,
            search: &w.search,
            prompt_actions: &w.prompt_actions,
            handles: &w.handles,
            hooks_guard: &w.hooks_guard,
            skill_guard: &w.skill_guard,
            pending: &w.pending,
            waits: &w.waits,
        };
        assert!(dispatch(&host, &ClientId::from("w1"), "open_settings_window", Value::Null).is_none());
    }

    #[test]
    fn handles_every_command_the_window_routes_here() {
        let ts = include_str!("../../../../src/lib/hostApiCommands.ts");
        let listed: Vec<&str> = ts
            .split('"')
            .enumerate()
            .filter(|(i, _)| i % 2 == 1)
            .map(|(_, s)| s)
            .collect();
        assert!(listed.len() >= 30);
        let w = world();
        let host = Host {
            workspaces: &w.workspaces,
            profiles: &w.profiles,
            ptys: &w.ptys,
            status: &w.status,
            layouts: &w.layouts,
            facts: &w.facts,
            agents: &w.agents,
            env: None,
            hook_env: None,
            events: &w.events,
            clients: &w.clients,
            files: &w.files,
            git: &w.git,
            worktrees: &w.worktrees,
            search: &w.search,
            prompt_actions: &w.prompt_actions,
            handles: &w.handles,
            hooks_guard: &w.hooks_guard,
            skill_guard: &w.skill_guard,
            pending: &w.pending,
            waits: &w.waits,
        };
        // Commands that take no arguments run for real: never the ones that
        // reach the user's machine (the keychain, the login shell's PATH,
        // their Agents' and skill folders).
        const REACH_OUT: &[&str] =
            &["env_retry_key", "agents_path_is_resolved", "agent_hook_status", "agent_skill_status"];
        for name in listed.into_iter().filter(|n| !REACH_OUT.contains(n)) {
            // Missing arguments: a host command says so; any other is `None`.
            assert!(dispatch(&host, &ClientId::from("w"), name, serde_json::json!({ "_": 0 })).is_some(), "{name}");
        }
    }
}
