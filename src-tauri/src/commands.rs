use tauri::{AppHandle, Emitter, Manager, State, Window};

use crate::error::AbundioError;
use crate::file_watcher::FileWatcher;
use crate::git_scheduler::GitScheduler;
use crate::profile_store::{
    ActiveProfileState, BusyCounts, BusyCountsState, Profile, ProfileStore, ProfileUpdate,
};
use crate::pty_manager::PtyManager;
use crate::workspace_store::{
    AgentTurnBucket, AgentTurnRecord, AgentTurnTotals, Bucket, GroupBy, Tab, TabUpdate,
    WorkspaceStore, WorkspaceUpdate, WorkspaceWithTabs,
};
use crate::worktree_watcher::WorktreeWatcher;
use crate::shell_env;

// ── PTY commands ──

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    window: Window,
    pty_mgr: State<'_, PtyManager>,
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
    // Workspace, resolved by the frontend (`inheritSourceWorkspaceId`) —
    // worktree grouping is not recomputed in Rust.
    workspace_id: Option<String>,
    inherit_from_workspace_id: Option<String>,
    // A **New task** launch (ADR-0042): the shell runs the Agent with the
    // Task prompt as a positional argument instead of a typed command.
    task: Option<crate::pty_manager::TaskLaunch>,
    store: State<'_, WorkspaceStore>,
) -> Result<String, AbundioError> {
    // Never start a Workspace pane in the wrong folder (ADR-0053): refuse a
    // Missing folder, and start in the Workspace folder when only the pane's
    // own remembered folder is gone. The lookup releases the store lock
    // before the disk is touched.
    let root = match workspace_id.as_deref() {
        Some(id) => store.root_folder(id)?,
        None => None,
    };
    // Off the async runtime: a `stat` on a hung mount can block for long.
    let cwd = tauri::async_runtime::spawn_blocking(move || {
        crate::pty_manager::resolve_spawn_cwd(&cwd, root.as_deref(), |p| {
            std::path::Path::new(p).is_dir()
        })
    })
    .await
    .map_err(|e| AbundioError::InvalidOperation(format!("folder check failed: {e}")))??;
    let hook_env = app
        .try_state::<crate::hook_server::HookServer>()
        .map(|h| crate::pty_manager::HookEnv {
            port: h.port,
            token: h.token.clone(),
        });
    let env_store = app.try_state::<crate::env_vars::EnvVarStore>();
    let pty_id = pty_mgr.spawn(
        crate::pty_manager::SpawnDeps {
            events: app.state::<crate::event_sink::Events>().inner().clone(),
            hook_env,
            env_store: env_store.as_deref(),
        },
        window.label(),
        &cwd,
        command.as_deref(),
        shell.as_deref(),
        cols,
        rows,
        log_id.as_deref(),
        pty_id.as_deref(),
        workspace_name.as_deref(),
        window_label.as_deref(),
        workspace_id.as_deref(),
        inherit_from_workspace_id.as_deref(),
        task.as_ref(),
    )?;
    // A spawn the Window sent just before it closed can land after its
    // `Destroyed` handler killed its PTYs. Kill it too if the Window is gone.
    //
    // This closes the gap only because Tauri drops the Window from its list
    // *before* running our `Destroyed` handler: tauri-runtime-wry 2.11.2 calls
    // the run-loop callback (whose `on_event_loop_event` runs
    // `manager.on_window_close`) and only then the per-window listeners that
    // `Builder::on_window_event` registers. So a spawn either inserts its owner
    // before `kill_for_window` sweeps, or sees the Window gone here. Re-check
    // this ordering when upgrading Tauri.
    if app.get_webview_window(window.label()).is_none() {
        let _ = pty_mgr.kill(&pty_id);
    }
    Ok(pty_id)
}

/// Give this Window's channel for every PTY's output (raw bytes, framed by
/// `event_sink::frame_pty_output`). Replaces an earlier one from the same
/// Window (a reload).
#[tauri::command]
pub fn pty_output_subscribe(
    window: Window,
    channels: State<'_, std::sync::Arc<crate::tauri_sink::PtyChannels>>,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) {
    channels.set(window.label(), channel);
}

#[tauri::command]
pub async fn list_available_shells() -> Result<Vec<shell_env::AvailableShell>, AbundioError> {
    Ok(shell_env::list_available_shells())
}

/// The shell a PTY spawns with when the user hasn't picked one (`shellPath`
/// null). The resolution lives in Rust (on Windows it prefers Git Bash, else
/// cmd.exe), so the frontend can't derive it — it calls this to learn what the
/// "System Default" resolves to (used by file-drop to pick the right path style).
#[tauri::command]
pub async fn default_shell() -> Result<String, AbundioError> {
    Ok(shell_env::default_shell())
}

#[tauri::command]
pub async fn pty_write(
    pty_mgr: State<'_, PtyManager>,
    pty_id: String,
    data: String,
) -> Result<(), AbundioError> {
    // data comes as a UTF-8 string from xterm.js onData
    pty_mgr.write(&pty_id, data.into_bytes())
}

#[tauri::command]
pub async fn pty_resize(
    pty_mgr: State<'_, PtyManager>,
    pty_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AbundioError> {
    pty_mgr.resize(&pty_id, cols, rows)
}

/// The text of a PTY's screen, from its Rust emulator (ADR-0063). The same
/// rules as `readBuffer.ts`; see `screen::Screen::read`.
#[tauri::command]
pub async fn pty_read_screen(
    pty_mgr: State<'_, PtyManager>,
    pty_id: String,
    visible: bool,
    lines: Option<usize>,
) -> Result<Vec<String>, AbundioError> {
    pty_mgr.read_screen(&pty_id, visible, lines)
}

/// How many lines of scrollback every PTY's screen keeps: the terminal
/// setting, pushed by the frontend at start and on every change.
#[tauri::command]
pub async fn pty_set_scrollback(pty_mgr: State<'_, PtyManager>, lines: usize) -> Result<(), AbundioError> {
    pty_mgr.set_scrollback(lines);
    Ok(())
}

/// Run status operations from this Window in the Rust status store, the
/// authority (ADR-0063), in order; return what the Window should show.
/// Synchronous, so batches never overtake each other.
#[tauri::command]
pub fn status_apply(
    window: Window,
    store: State<'_, std::sync::Arc<crate::status_store::StatusStore>>,
    ops: Vec<crate::status_store::StatusOp>,
) -> Vec<crate::status_store::StatusUpdate> {
    let client = crate::event_sink::ClientId::from(window.label());
    let config = crate::status_machine::StatusConfig::default();
    ops.into_iter()
        .filter_map(|op| store.run_op(&client, op, &config))
        .collect()
}

/// The Agents a command typed at a prompt is matched against (the user's
/// list: custom Agents, disabled ones), so Rust sees a typed Agent start
/// (shell integration, phase 6d-4). Every Window sends it on a change.
#[tauri::command]
pub fn agent_commands_set(
    agents: State<'_, std::sync::Arc<crate::shell_integration::AgentCommands>>,
    list: Vec<crate::shell_integration::AgentCommand>,
) {
    agents.set(list);
}

/// Ask the program in a PTY to redraw at its current size (SIGWINCH to the
/// foreground process group). `false` where unsupported (Windows).
#[tauri::command]
pub async fn pty_redraw(
    pty_mgr: State<'_, PtyManager>,
    pty_id: String,
) -> Result<bool, AbundioError> {
    pty_mgr.redraw(&pty_id)
}

#[tauri::command]
pub async fn pty_kill(
    pty_mgr: State<'_, PtyManager>,
    pty_id: String,
) -> Result<(), AbundioError> {
    pty_mgr.kill(&pty_id)
}

// ── Menu ──

/// Sets the accelerator on the menu's Settings… item to the frontend's
/// **Open settings** Shortcut (`None` when Unbound), then rebuilds the menu.
/// Every Profile window pushes on start and on change; the menu signature
/// makes a repeat of the same value free.
#[tauri::command]
pub fn set_settings_accelerator(
    app: AppHandle,
    accelerator: Option<String>,
) -> Result<(), AbundioError> {
    if let Some(a) = &accelerator {
        if !crate::is_valid_accelerator(a) {
            return Err(AbundioError::InvalidOperation(format!(
                "invalid accelerator: {a:?}"
            )));
        }
    }
    if let Some(state) = app.try_state::<crate::SettingsAccelerator>() {
        if state.set(accelerator) {
            crate::rebuild_menu_for_focused_window(&app);
        }
    }
    Ok(())
}

// ── Profile commands ──

fn rebuild_menu_after_profile_change(app: &AppHandle) {
    crate::rebuild_menu_for_focused_window(app);
}

#[tauri::command]
pub async fn profile_list(store: State<'_, ProfileStore>) -> Result<Vec<Profile>, AbundioError> {
    store.list()
}

#[tauri::command]
pub async fn profile_create(
    app: AppHandle,
    store: State<'_, ProfileStore>,
    name: String,
) -> Result<Profile, AbundioError> {
    let profile = store.create(&name)?;
    rebuild_menu_after_profile_change(&app);
    let _ = app.emit("profiles-changed", ());
    Ok(profile)
}

#[tauri::command]
pub async fn profile_update(
    app: AppHandle,
    store: State<'_, ProfileStore>,
    id: String,
    updates: ProfileUpdate,
) -> Result<(), AbundioError> {
    store.update(&id, updates)?;
    rebuild_menu_after_profile_change(&app);
    let _ = app.emit("profiles-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn profile_delete(
    app: AppHandle,
    store: State<'_, ProfileStore>,
    workspaces: State<'_, WorkspaceStore>,
    active_state: State<'_, ActiveProfileState>,
    id: String,
) -> Result<(), AbundioError> {
    // The frontend confirm dialog warns the user when deletion will also
    // close a window. The "at least one profile must exist" rule is still
    // enforced inside ProfileStore::delete (returns InvalidOperation).
    //
    // If the profile is currently open in some window, destroy that window
    // first so it doesn't briefly continue rendering against rows that the
    // FK cascade is about to remove.
    if let Some(owner_label) = active_state.owner_of_profile(&id) {
        if let Some(owning_window) = app.get_webview_window(&owner_label) {
            let _ = owning_window.destroy();
        }
        active_state.remove_for_window(&owner_label);
    }

    // Read before the row goes: a default Orchestrator folder goes with its
    // Profile, one the user chose stays (ADR-0059). Only once the delete
    // itself is allowed.
    let orchestrator = workspaces
        .orchestrator_folder_of(&id)
        .ok()
        .flatten()
        // Never a folder another Workspace still points into.
        .filter(|f| {
            let rows = workspaces.all_folders().unwrap_or_default();
            !crate::workspace_folders::holds_work(&rows, std::path::Path::new(f))
        });
    store.delete(&id)?;
    if let Some(folder) = orchestrator {
        crate::orchestrator::forget_folder_at(
            &crate::app_paths::shared_root(),
            std::path::Path::new(&folder),
        );
    }
    rebuild_menu_after_profile_change(&app);
    let _ = app.emit("profiles-changed", ());
    let _ = app.emit("profile-ownership-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn profile_reorder(
    app: AppHandle,
    store: State<'_, ProfileStore>,
    ids: Vec<String>,
) -> Result<(), AbundioError> {
    store.reorder(&ids)?;
    rebuild_menu_after_profile_change(&app);
    let _ = app.emit("profiles-changed", ());
    Ok(())
}

/// Called by the frontend whenever the active profile for the calling window
/// changes (in-window switch, or on initial load to sync the map). Updates the
/// per-window ownership map, rebuilds the native menu, and broadcasts a
/// `profile-ownership-changed` event so other Windows can refresh their UI.
///
/// Errors when another Window already owns the profile, so the "one Profile,
/// at most one Window" rule holds even if two Windows try the same switch.
///
/// Rejects calls from auxiliary windows (e.g. settings) — those never own a
/// profile by definition (ADR-0007), and accepting their writes would pollute
/// the ownership map. The frontend bypasses this command in those windows,
/// but the backend rejects defensively so a future bug can't silently
/// register a stale entry that survives in windows.json across restarts.
#[tauri::command]
pub async fn set_active_profile_id(
    app: AppHandle,
    window: Window,
    state: State<'_, ActiveProfileState>,
    profile_id: Option<String>,
) -> Result<(), AbundioError> {
    let label = window.label().to_string();
    if !crate::window_management::is_profile_window_label(&label) {
        return Ok(());
    }
    state.claim_for_window(&label, profile_id.as_deref())?;
    crate::rebuild_menu_for_focused_window(&app);
    let _ = app.emit("profile-ownership-changed", ());
    Ok(())
}

/// Frontend startup call: returns the profile id this Window was spawned with
/// (or None if the map is missing this window, in which case the frontend
/// should fall back to its persisted/first-profile logic and report back).
#[tauri::command]
pub async fn get_active_profile_for_window(
    window: Window,
    state: State<'_, ActiveProfileState>,
) -> Result<Option<String>, AbundioError> {
    Ok(state.get_for_window(window.label()))
}

/// The frontend pushes its Window's **busy tally** whenever the tuple changes,
/// so Rust can sum across all Windows at quit time and decide whether to
/// confirm — and what the confirmation should say (see ADR-0034). Auxiliary
/// windows (settings) never own workspaces and are ignored defensively,
/// mirroring `set_active_profile_id`.
#[tauri::command]
pub async fn report_busy_counts(
    window: Window,
    state: State<'_, BusyCountsState>,
    counts: BusyCounts,
) -> Result<(), AbundioError> {
    let label = window.label().to_string();
    if !crate::window_management::is_profile_window_label(&label) {
        return Ok(());
    }
    state.set_for_window(&label, counts);
    Ok(())
}

/// Returns the full profileId → windowLabel ownership map. The frontend uses
/// this to render "Open in another window" disabled-states in the Settings UI.
#[tauri::command]
pub async fn get_profile_ownership_map(
    state: State<'_, ActiveProfileState>,
) -> Result<std::collections::HashMap<String, String>, AbundioError> {
    // We invert the (label → profileId) map for the frontend: it wants
    // profileId → label so it can look up "who owns profile X?" cheaply.
    let snapshot = state.snapshot();
    let inverted: std::collections::HashMap<String, String> = snapshot
        .into_iter()
        .map(|(label, profile_id)| (profile_id, label))
        .collect();
    Ok(inverted)
}

#[tauri::command]
pub async fn open_window_with_profile(
    app: AppHandle,
    profile_id: String,
) -> Result<String, AbundioError> {
    crate::window_management::open_window_with_profile(&app, &profile_id)
}

#[tauri::command]
pub async fn open_settings_window(
    app: AppHandle,
    section: Option<String>,
) -> Result<(), AbundioError> {
    crate::window_management::open_or_focus_settings_window(&app, section.as_deref())
}

/// Focus the window identified by `label`. Used by the frontend's
/// `requestSwitchProfile` path when the target profile is already open in
/// another window — see ADR-0007 follow-up.
#[tauri::command]
pub async fn focus_window(app: AppHandle, label: String) -> Result<(), AbundioError> {
    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|e| {
            AbundioError::InvalidOperation(format!("focus failed: {}", e))
        })?;
        Ok(())
    } else {
        Err(AbundioError::NotFound(format!("Window not found: {}", label)))
    }
}

#[tauri::command]
pub async fn create_untitled_profile_in_new_window(
    app: AppHandle,
) -> Result<String, AbundioError> {
    crate::window_management::create_untitled_profile_in_new_window(&app)
}

// ── Workspace commands ──

#[tauri::command]
pub async fn workspace_create(
    store: State<'_, WorkspaceStore>,
    name: String,
    root_folder: String,
    profile_id: String,
) -> Result<WorkspaceWithTabs, AbundioError> {
    // One folder per Profile, never an Orchestrator folder (GLOSSARY.md).
    crate::workspace_folders::enforce(&crate::workspace_folders::check(
        &store,
        &crate::app_paths::shared_root(),
        &root_folder,
        &profile_id,
        None,
    )?)?;
    store.create(&name, &root_folder, &profile_id)
}

#[tauri::command]
pub async fn workspace_list(
    store: State<'_, WorkspaceStore>,
    profile_id: String,
) -> Result<Vec<WorkspaceWithTabs>, AbundioError> {
    store.list(&profile_id)
}

#[tauri::command]
pub async fn workspace_update(
    store: State<'_, WorkspaceStore>,
    id: String,
    updates: WorkspaceUpdate,
) -> Result<(), AbundioError> {
    if let Some(folder) = &updates.root_folder {
        if let Some(profile_id) = store.profile_of(&id)? {
            crate::workspace_folders::enforce(&crate::workspace_folders::check(
                &store,
                &crate::app_paths::shared_root(),
                folder,
                &profile_id,
                Some(&id),
            )?)?;
        }
    }
    store.update(&id, updates)
}

#[tauri::command]
pub async fn workspace_delete(
    store: State<'_, WorkspaceStore>,
    id: String,
) -> Result<(), AbundioError> {
    store.delete(&id)
}

/// Ids of the Profile's Workspaces whose folder is missing (ADR-0053).
#[tauri::command]
pub async fn workspace_missing_folders(
    store: State<'_, WorkspaceStore>,
    profile_id: String,
) -> Result<Vec<String>, AbundioError> {
    let rows = store.folder_rows(&profile_id)?;
    // `stat` on a hung network mount can block for tens of seconds; keep it
    // off the async runtime's worker threads. Runs on every Window focus.
    tauri::async_runtime::spawn_blocking(move || {
        crate::workspace_store::missing_ids(rows, |p| std::path::Path::new(p).is_dir())
    })
    .await
    .map_err(|e| AbundioError::InvalidOperation(format!("folder check failed: {e}")))
}

/// A Profile's **Workspace restore** list (ADR-0052).
#[tauri::command]
pub async fn workspace_restore_set(
    store: State<'_, WorkspaceStore>,
    profile_id: String,
) -> Result<crate::workspace_store::RestoreSet, AbundioError> {
    store.restore_set(&profile_id)
}

#[tauri::command]
pub async fn workspace_set_restore_opened(
    store: State<'_, WorkspaceStore>,
    id: String,
    opened: bool,
) -> Result<(), AbundioError> {
    store.set_restore_opened(&id, opened)
}

#[tauri::command]
pub async fn workspace_set_restore_active(
    store: State<'_, WorkspaceStore>,
    profile_id: String,
    id: Option<String>,
) -> Result<(), AbundioError> {
    store.set_restore_active(&profile_id, id.as_deref())
}

#[tauri::command]
pub async fn workspace_reorder(
    store: State<'_, WorkspaceStore>,
    ids: Vec<String>,
) -> Result<(), AbundioError> {
    store.reorder_workspaces(&ids)
}

// ── Tab commands ──

/// A Workspace's Tabs, as sent to the Profile's other Windows when one is
/// created, closed, renamed or moved (`tabs-changed`, ADR-0063).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TabsChanged {
    workspace_id: String,
    tabs: Vec<Tab>,
}

/// Tell the Windows of `profile_id` the Workspace's Tabs now: every one but
/// `origin`, which made the change itself (`None`: Rust did, tell them all).
pub(crate) fn send_tabs_changed(
    store: &WorkspaceStore,
    profiles: &crate::profile_store::ActiveProfileState,
    events: &crate::event_sink::Events,
    origin: Option<&crate::event_sink::ClientId>,
    workspace_id: &str,
    profile_id: &str,
) {
    use crate::event_sink::EventsExt;
    let nobody = crate::event_sink::ClientId(String::new());
    let targets = crate::layout_store::broadcast_targets(
        &profiles.snapshot(),
        profile_id,
        origin.unwrap_or(&nobody),
    );
    if targets.is_empty() {
        return;
    }
    let tabs = match store.list_tabs(workspace_id) {
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

#[tauri::command]
pub async fn tab_create(
    window: Window,
    store: State<'_, WorkspaceStore>,
    profiles: State<'_, crate::profile_store::ActiveProfileState>,
    events: State<'_, crate::event_sink::Events>,
    workspace_id: String,
    name: String,
) -> Result<Tab, AbundioError> {
    let tab = store.create_tab(&workspace_id, &name)?;
    if let Some(profile_id) = store.profile_of(&workspace_id)? {
        send_tabs_changed(&store, &profiles, &events, Some(&crate::event_sink::ClientId::from(window.label())), &workspace_id, &profile_id);
    }
    Ok(tab)
}

#[tauri::command]
pub async fn tab_list(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
) -> Result<Vec<Tab>, AbundioError> {
    store.list_tabs(&workspace_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn tab_update(
    window: Window,
    store: State<'_, WorkspaceStore>,
    layouts: State<'_, std::sync::Arc<crate::layout_store::LayoutStore>>,
    profiles: State<'_, crate::profile_store::ActiveProfileState>,
    events: State<'_, crate::event_sink::Events>,
    id: String,
    updates: TabUpdate,
) -> Result<(), AbundioError> {
    // A layout written here bypasses the layout store: let it read afresh.
    if updates.layout_json.is_some() {
        layouts.forget(&id);
    }
    let tab_level = updates.name.is_some() || updates.position.is_some();
    store.update_tab(&id, updates)?;
    if tab_level {
        if let Some((workspace_id, profile_id)) = store.tab_owner(&id)? {
            send_tabs_changed(&store, &profiles, &events, Some(&crate::event_sink::ClientId::from(window.label())), &workspace_id, &profile_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn tab_delete(
    window: Window,
    store: State<'_, WorkspaceStore>,
    layouts: State<'_, std::sync::Arc<crate::layout_store::LayoutStore>>,
    profiles: State<'_, crate::profile_store::ActiveProfileState>,
    events: State<'_, crate::event_sink::Events>,
    id: String,
) -> Result<(), AbundioError> {
    layouts.forget(&id);
    let owner = store.tab_owner(&id)?;
    store.delete_tab(&id)?;
    if let Some((workspace_id, profile_id)) = owner {
        send_tabs_changed(&store, &profiles, &events, Some(&crate::event_sink::ClientId::from(window.label())), &workspace_id, &profile_id);
    }
    Ok(())
}

/// The Window's facts about its panes that Rust does not see yet (title,
/// live folder, running command, detected Agent, Progress line), for Agent
/// control to describe them (`pane_facts.rs`).
#[tauri::command]
pub fn pane_facts_report(
    facts: State<'_, crate::pane_facts::PaneFactsStore>,
    reports: Vec<crate::pane_facts::PaneFactsReport>,
) {
    facts.apply(reports);
}

/// Apply a Window's edits to a Tab's layout: Rust is the authority
/// (ADR-0063). Saves the result and sends it to the Profile's other Windows
/// as `layout-changed`; answers with the layout as it now stands. The
/// Window sends one batch at a time, so batches never overtake each other.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn layout_apply(
    window: Window,
    store: State<'_, WorkspaceStore>,
    layouts: State<'_, std::sync::Arc<crate::layout_store::LayoutStore>>,
    pty_mgr: State<'_, PtyManager>,
    profiles: State<'_, crate::profile_store::ActiveProfileState>,
    events: State<'_, crate::event_sink::Events>,
    tab_id: String,
    ops: Vec<crate::layout_ops::LayoutOp>,
) -> Result<crate::layout_store::LayoutState, AbundioError> {
    use crate::event_sink::EventsExt;
    let applied = layouts.apply(&store, &tab_id, &ops, &|id| pty_mgr.is_live(id))?;
    if applied.changed {
        let origin = crate::event_sink::ClientId::from(window.label());
        for client in crate::layout_store::broadcast_targets(
            &profiles.snapshot(),
            &applied.profile_id,
            &origin,
        ) {
            events.to_client(&client, "layout-changed", &applied.state);
        }
    }
    Ok(applied.state)
}

// ── Note commands ──

#[tauri::command]
pub async fn note_get(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
) -> Result<String, AbundioError> {
    store.get_note(&workspace_id)
}

#[tauri::command]
pub async fn note_set(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    content: String,
) -> Result<(), AbundioError> {
    store.set_note(&workspace_id, &content)
}

// ── Agent telemetry commands ──
//
// The frontend Turn tracker records one row per Turn at finalize; the
// Statistics overlay queries Profile-scoped rollups. See
// docs/plans/agent-turn-telemetry-and-statistics-overlay.md and ADR-0018.

#[tauri::command]
pub async fn telemetry_record_turn(
    store: State<'_, WorkspaceStore>,
    turn: AgentTurnRecord,
) -> Result<(), AbundioError> {
    store.record_agent_turn(&turn)
}

#[tauri::command]
pub async fn telemetry_buckets(
    store: State<'_, WorkspaceStore>,
    profile_id: String,
    from_ms: i64,
    to_ms: i64,
    bucket: String,
    group_by: String,
) -> Result<Vec<AgentTurnBucket>, AbundioError> {
    store.agent_turn_buckets(
        &profile_id,
        from_ms,
        to_ms,
        Bucket::parse(&bucket)?,
        GroupBy::parse(&group_by)?,
    )
}

#[tauri::command]
pub async fn telemetry_totals(
    store: State<'_, WorkspaceStore>,
    profile_id: String,
    from_ms: i64,
    to_ms: i64,
) -> Result<AgentTurnTotals, AbundioError> {
    store.agent_turn_totals(&profile_id, from_ms, to_ms)
}

#[tauri::command]
pub async fn telemetry_list_turns(
    store: State<'_, WorkspaceStore>,
    profile_id: String,
    from_ms: i64,
    to_ms: i64,
) -> Result<Vec<AgentTurnRecord>, AbundioError> {
    store.list_agent_turns(&profile_id, from_ms, to_ms)
}

// ── PTY log commands ──

#[tauri::command]
pub async fn pty_read_log(log_id: String) -> Result<Option<String>, AbundioError> {
    PtyManager::read_log(&log_id)
}

#[tauri::command]
pub async fn pty_write_snapshot(pane_id: String, data: String) -> Result<(), AbundioError> {
    PtyManager::write_snapshot(&pane_id, &data)
}

#[tauri::command]
pub async fn pty_read_snapshot(pane_id: String) -> Result<Option<String>, AbundioError> {
    PtyManager::read_snapshot(&pane_id)
}

#[tauri::command]
pub async fn pty_delete_log(log_id: String) -> Result<(), AbundioError> {
    PtyManager::delete_log(&log_id)
}

#[tauri::command]
pub async fn pty_cleanup_stale_logs(pane_ids: Vec<String>) -> Result<(), AbundioError> {
    PtyManager::cleanup_stale_logs(&pane_ids)
}

// ── File watcher commands ──

#[tauri::command]
pub async fn fs_watch_start(
    app: AppHandle,
    events: State<'_, crate::event_sink::Events>,
    window: Window,
    watcher: State<'_, FileWatcher>,
    root_path: String,
) -> Result<(), AbundioError> {
    watcher.start_watching(events.inner().clone(), window.label(), &root_path)?;
    // A start the Window sent just before it closed can land after its
    // `Destroyed` handler released its holds, and would claim under a label
    // nothing releases again. Let go if the Window is already gone.
    if app.get_webview_window(window.label()).is_none() {
        watcher.stop_watching(window.label(), &root_path);
    }
    Ok(())
}

#[tauri::command]
pub async fn fs_watch_stop(
    window: Window,
    watcher: State<'_, FileWatcher>,
    root_path: String,
) -> Result<(), AbundioError> {
    watcher.stop_watching(window.label(), &root_path);
    Ok(())
}

// ── Worktree live-sync watcher ──

/// Set the calling Window's desired set of watched repository common dirs.
/// The Rust watcher reconciles the union across Windows and emits
/// `worktrees-changed` when a `git worktree add/remove` touches one. The
/// frontend recomputes `common_dirs` from its workspace git summaries whenever
/// the workspace list or grouping changes. See ADR-0017.
#[tauri::command]
pub async fn worktree_watch_set(
    events: State<'_, crate::event_sink::Events>,
    window: Window,
    watcher: State<'_, WorktreeWatcher>,
    common_dirs: Vec<String>,
) -> Result<(), AbundioError> {
    watcher.set_watched(events.inner(), window.label(), common_dirs);
    Ok(())
}

// ── Git scheduler commands ──
//
// Per-workspace Rust-initiated git refresh. The frontend calls `start` on
// workspace open and `stop` on close; in between, the scheduler emits
// `git-state-<workspaceId>` events whenever the file watcher detects
// meaningful change. This replaces the JS-side `fetchChanges`-on-every-event
// pattern that froze the main thread during `git stash` (see git_scheduler.rs).

#[tauri::command]
pub async fn git_scheduler_start(
    app: AppHandle,
    events: State<'_, crate::event_sink::Events>,
    window: Window,
    scheduler: State<'_, GitScheduler>,
    workspace_id: String,
    root_path: String,
    base_branch: Option<String>,
) -> Result<(), AbundioError> {
    scheduler.start(
        events.inner().clone(),
        window.label(),
        workspace_id.clone(),
        root_path,
        base_branch,
    );
    // See `fs_watch_start`: undo a claim that landed after the Window closed.
    if app.get_webview_window(window.label()).is_none() {
        scheduler.stop(window.label(), &workspace_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn git_scheduler_stop(
    window: Window,
    scheduler: State<'_, GitScheduler>,
    workspace_id: String,
) -> Result<(), AbundioError> {
    scheduler.stop(window.label(), &workspace_id);
    Ok(())
}

// ── Font commands ──

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, AbundioError> {
    let families = tauri::async_runtime::spawn_blocking(|| {
        font_kit::source::SystemSource::new()
            .all_families()
            .map_err(|e| AbundioError::Font(e.to_string()))
    })
    .await
    .map_err(|e| AbundioError::Font(e.to_string()))??;
    Ok(families)
}

// ── Agent hooks ──

/// Enable or disable Agent status hooks by (un)provisioning hook configs in
/// each installed Agent's global config directory. `enabled_agents` are the
/// agent ids whose per-agent toggle is on — only those are provisioned; the
/// rest are stripped (so toggling one agent off removes just its hooks).
#[tauri::command]
pub async fn agent_hooks_provision(
    enabled: bool,
    enabled_agents: Vec<String>,
) -> Result<(), AbundioError> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_hooks::provision(enabled, &enabled_agents)
    })
    .await
    .map_err(|e| AbundioError::Io(std::io::Error::other(e.to_string())))?
}

/// Provision hooks at app startup, exactly once per process. Every Window's
/// settings rehydrate calls this with the persisted enabled flag and the set of
/// per-agent-enabled ids; the guard makes only the first call do the work, so N
/// Windows don't each rewrite the same global config files. See ADR-0003
/// (Revisited).
#[tauri::command]
pub async fn agent_hooks_provision_startup(
    enabled: bool,
    enabled_agents: Vec<String>,
    guard: State<'_, crate::agent_hooks::StartupProvisionGuard>,
) -> Result<(), AbundioError> {
    if !guard.claim() {
        return Ok(());
    }
    // Startup provisioning is the invisible path — when it silently doesn't
    // run, hooks quietly stay stale (frontend console errors live in the
    // webview, not the terminal). Leave a breadcrumb where a dev can see it.
    eprintln!(
        "[abundio] startup hook provisioning: enabled={enabled}, agents={enabled_agents:?}"
    );
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::agent_hooks::provision(enabled, &enabled_agents);
        if let Err(e) = &result {
            eprintln!("[abundio] startup hook provisioning failed: {e}");
        }
        result
    })
    .await
    .map_err(|e| AbundioError::Io(std::io::Error::other(e.to_string())))?
}

/// Register hooks for a single Agent on demand if they aren't already, creating
/// the Agent's config dir if needed. Called when an Agent is launched so a
/// mid-session install gets hooks without restarting. Returns whether it
/// provisioned. No-op when hooks are disabled or the Agent is unsupported.
#[tauri::command]
pub async fn ensure_agent_hooks(agent_id: String, enabled: bool) -> Result<bool, AbundioError> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_hooks::ensure_agent_hooks(&agent_id, enabled)
    })
    .await
    .map_err(|e| AbundioError::Io(std::io::Error::other(e.to_string())))?
}

/// Read-only per-Agent provisioning footprint (config path, ownership, hooked
/// events, registration state) for the Settings UI.
#[tauri::command]
pub async fn agent_hook_status(
) -> Result<Vec<crate::agent_hooks::AgentHookStatus>, AbundioError> {
    tauri::async_runtime::spawn_blocking(crate::agent_hooks::agent_hook_status)
        .await
        .map_err(|e| AbundioError::Io(std::io::Error::other(e.to_string())))?
}
