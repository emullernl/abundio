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
}

/// Everything a host command reaches.
pub struct Host<'a> {
    pub workspaces: &'a WorkspaceStore,
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

/// Run one host command for `client`. `None` when the command is not one of
/// these.
pub fn dispatch(host: &Host, client: &ClientId, command: &str, raw: Value) -> Option<Result<Value, AbundioError>> {
    run(host, client, command, raw).transpose()
}

fn run(host: &Host, client: &ClientId, command: &str, raw: Value) -> Result<Option<Value>, AbundioError> {
    use crate::file_explorer as fe;
    use crate::git_commands as gc;
    use crate::pty_manager::PtyManager;
    use crate::worktree_commands as wt;
    let c = command;
    let out = match command {
        // ── Terminals ──
        "pty_spawn" => json(pty_spawn(host, client, args(c, raw)?)?)?,
        "pty_write" => {
            let a = a!(c, raw, { pty_id: String, data: String });
            // As typed in xterm.js: UTF-8 text.
            json(host.ptys.write(&a.pty_id, a.data.into_bytes())?)?
        }
        "pty_resize" => {
            let a = a!(c, raw, { pty_id: String, cols: u16, rows: u16 });
            json(host.ptys.resize(&a.pty_id, a.cols, a.rows)?)?
        }
        "pty_kill" => json(host.ptys.kill(&a!(c, raw, { pty_id: String }).pty_id)?)?,
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
            host.agents.set(a!(c, raw, { list: Vec<crate::shell_integration::AgentCommand> }).list);
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
            json(host.workspaces.create(&a.name, &a.root_folder, &a.profile_id)?)?
        }
        "workspace_update" => {
            let a = a!(c, raw, { id: String, updates: WorkspaceUpdate });
            if let Some(folder) = &a.updates.root_folder {
                if let Some(profile_id) = host.workspaces.profile_of(&a.id)? {
                    crate::workspace_folders::enforce(&folder_check(host, folder, &profile_id, Some(&a.id))?)?;
                }
            }
            json(host.workspaces.update(&a.id, a.updates)?)?
        }
        "workspace_delete" => json(host.workspaces.delete(&a!(c, raw, { id: String }).id)?)?,
        "workspace_folder_check" => {
            let a = a!(c, raw, { root_folder: String, profile_id: String });
            json(folder_check(host, &a.root_folder, &a.profile_id, None)?)?
        }
        "workspace_missing_folders" => {
            let rows = host.workspaces.folder_rows(&a!(c, raw, { profile_id: String }).profile_id)?;
            json(crate::workspace_store::missing_ids(rows, |p| std::path::Path::new(p).is_dir()))?
        }
        "workspace_reorder" => json(host.workspaces.reorder_workspaces(&a!(c, raw, { ids: Vec<String> }).ids)?)?,
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
        "git_scheduler_stop" => {
            host.git.stop(client.as_str(), &a!(c, raw, { workspace_id: String }).workspace_id);
            Value::Null
        }
        "gh_list_issues" => json(crate::gh_commands::gh_list_issues(a!(c, raw, { cwd: String }).cwd)?)?,

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
        _ => return Ok(None),
    };
    Ok(Some(out))
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
    let pty_id = host.ptys.spawn(
        crate::pty_manager::SpawnDeps {
            events: host.events.clone(),
            hook_env: host.hook_env.clone(),
            env_store: host.env,
        },
        client.as_str(),
        &cwd,
        a.command.as_deref(),
        a.shell.as_deref(),
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
    }

    const PID: &str = "00000000-0000-0000-0000-000000000001";

    fn world() -> World {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        let sink = Arc::new(Sink::default());
        World {
            workspaces: WorkspaceStore::new(conn),
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
        }
    }

    fn call(w: &World, client: &str, command: &str, a: Value) -> Result<Value, AbundioError> {
        let host = Host {
            workspaces: &w.workspaces,
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
        };
        dispatch(&host, &ClientId::from(client), command, a).expect("a host command")
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

        let tab = call(&w, "w1", "tab_create", serde_json::json!({ "workspaceId": ws_id, "name": "T" })).unwrap();
        assert_eq!(tab["name"], "T");
        assert_eq!(*w.sink.0.lock().unwrap(), vec![("w2".to_string(), "tabs-changed".to_string())]);
        let listed = call(&w, "w2", "workspace_list", serde_json::json!({ "profileId": PID })).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(call(&w, "w1", "default_shell", Value::Null).unwrap().as_str().map(|s| !s.is_empty()), Some(true));
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
        };
        for name in listed {
            // Missing arguments: a host command says so; any other is `None`.
            assert!(dispatch(&host, &ClientId::from("w"), name, serde_json::json!({ "_": 0 })).is_some(), "{name}");
        }
    }
}
