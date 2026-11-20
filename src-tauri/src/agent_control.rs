//! **Agent control** (ADR-0054): an Agent in one Pane driving other Panes of
//! its Workspace through the `abundio` command.
//!
//! Rust checks and routes; the Window carries the call out. A request arrives
//! on the hook server's `/control` route with the caller's per-pane token. The
//! token alone says who is calling ([`ControlTokens`]); the request's argv is
//! parsed here ([`parse_args`]), the setting is checked, and the request is
//! sent to the Window that owns the caller's Workspace as an
//! `agent-control-request` event. The Window answers with the
//! `agent_control_reply` command, which completes the waiting HTTP thread
//! ([`PendingRequests`]).
//!
//! Every wait passes through here, so Rust keeps the graph of who is waiting
//! on whom ([`WaitGraph`]) and refuses a wait that would close a loop.

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

pub use crate::control_protocol::*;

use crate::error::AbundioError;
use crate::pane_facts::PaneFacts;
use crate::status_store::StoreView;
use crate::workspace_store::WorkspaceWithTabs;


/// Where `workspace close <name>` goes. Never the caller's own Workspace,
/// and never opened for the call: a Workspace with no live PTY is routed to
/// the caller's Window, which holds it if it is Opened at all (a Profile is
/// open in at most one Window) and otherwise answers that it is closed.
/// A Missing folder is no reason to refuse: closing starts nothing.
fn close_scope(app: &AppHandle, caller: &Caller, name: &str) -> Result<Scope, Answer> {
    let store = app
        .try_state::<crate::workspace_store::WorkspaceStore>()
        .ok_or_else(|| error_answer(503, "unavailable", "Agent control is not ready"))?;
    let target = workspace_in_profile(&store, caller, name)?;
    let live = app
        .try_state::<crate::pty_manager::PtyManager>()
        .and_then(|mgr| mgr.control_tokens().window_for_workspace(&target.id));
    close_scope_for(caller, &target, live)
}

/// Where a call naming `workspace` goes, for `caller`.
fn resolve_scope(app: &AppHandle, caller: &Caller, workspace: Option<&str>) -> Result<Scope, Answer> {
    let Some(name) = workspace else {
        return Ok(Scope::home(caller));
    };
    let store = app
        .try_state::<crate::workspace_store::WorkspaceStore>()
        .ok_or_else(|| error_answer(503, "unavailable", "Agent control is not ready"))?;
    let target = workspace_in_profile(&store, caller, name)?;
    if target.id == caller.workspace_id {
        return Ok(Scope::home(caller));
    }
    // Nothing new starts in a Missing folder (ADR-0053).
    if !std::path::Path::new(&target.folder).is_dir() {
        return Err(error_answer(
            409,
            "folder_missing",
            &format!("the Workspace {:?} has lost its folder ({})", target.name, target.folder),
        ));
    }
    let live = app
        .try_state::<crate::pty_manager::PtyManager>()
        .and_then(|mgr| mgr.control_tokens().window_for_workspace(&target.id));
    Ok(match live {
        Some(window_label) => Scope {
            workspace_id: target.id.clone(),
            open: false,
            window_label,
            client_id: None,
        },
        // Not Opened anywhere: the caller's Window opens it in the background.
        None => Scope {
            workspace_id: target.id.clone(),
            open: true,
            window_label: caller.window_label.clone(),
            client_id: None,
        },
    })
}

fn workspace_list_answer(app: &AppHandle, caller: &Caller) -> Answer {
    let Some(store) = app.try_state::<crate::workspace_store::WorkspaceStore>() else {
        return error_answer(503, "unavailable", "Agent control is not ready");
    };
    let tokens = app.try_state::<crate::pty_manager::PtyManager>();
    let is_open = |ws: &str| {
        tokens
            .as_ref()
            .and_then(|m| m.control_tokens().window_for_workspace(ws))
            .is_some()
    };
    match workspace_listing(&store, caller, &is_open) {
        Ok(v) => Answer {
            status: 200,
            body: v.to_string(),
        },
        Err(e) => error_answer(500, "internal", &e.to_string()),
    }
}

/// Send `request` to the target's Window and wait up to `limit` for its reply
/// (`None`: no limit). On a timeout the Window is told to drop the request.
fn ask_window(
    app: &AppHandle,
    caller: &Caller,
    scope: &Scope,
    request: &Value,
    limit: Option<Duration>,
) -> Result<Value, Answer> {
    if app.get_webview_window(&scope.window_label).is_none() {
        return Err(error_answer(
            503,
            "window_gone",
            "the Window that owns this Workspace is closed",
        ));
    }
    let pending = app
        .try_state::<PendingRequests>()
        .ok_or_else(|| error_answer(503, "unavailable", "Agent control is not ready"))?;
    let (id, rx) = pending.register(&scope.window_label);
    if let Some(client) = &scope.client_id {
        pending.track_client(client, &id, &caller.pty_id, &scope.window_label);
    }
    let event = ControlEvent {
        id: &id,
        caller,
        target: scope,
        request,
    };
    if app
        .emit_to(&scope.window_label, "agent-control-request", event)
        .is_err()
    {
        pending.forget(&id);
        if let Some(client) = &scope.client_id {
            pending.untrack_client(client, &caller.pty_id, &id);
        }
        return Err(error_answer(503, "window_gone", "could not reach the Window"));
    }
    let reply = wait_for_reply(&rx, limit, WINDOW_CHECK_EVERY, || {
        app.get_webview_window(&scope.window_label).is_some()
    });
    if let Some(client) = &scope.client_id {
        pending.untrack_client(client, &caller.pty_id, &id);
    }
    match reply {
        Reply::Answer(v) => Ok(v),
        Reply::WindowGone => {
            pending.forget(&id);
            Err(error_answer(
                503,
                "window_gone",
                "the Window that owned this Workspace closed before it answered; the action may have happened, so check before retrying",
            ))
        }
        Reply::TimedOut => {
            pending.forget(&id);
            let _ = app.emit_to(
                &scope.window_label,
                "agent-control-cancel",
                json!({ "id": id }),
            );
            Err(error_answer(
                504,
                "timeout",
                "no answer in time; the action may still have happened, so check before retrying",
            ))
        }
    }
}

/// What the user sees of a call Rust answers, drawn by the owning Window.
struct WindowEffects<'a> {
    app: &'a AppHandle,
    window_label: &'a str,
}

impl crate::control_local::Effects for WindowEffects<'_> {
    fn begin(&self, caller_pane: &str, target_pane: &str, by: &str, kind: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let _ = self.app.emit_to(
            self.window_label,
            "agent-control-effect",
            json!({
                "type": "begin", "id": id, "callerPaneId": caller_pane,
                "targetPaneId": target_pane, "by": by, "kind": kind,
            }),
        );
        id
    }
    fn end(&self, id: &str) {
        let _ = self
            .app
            .emit_to(self.window_label, "agent-control-effect", json!({ "type": "end", "id": id }));
    }
    fn input(&self, pane_id: &str, data: &str) {
        let _ = self.app.emit_to(
            self.window_label,
            "agent-control-effect",
            json!({ "type": "input", "paneId": pane_id, "data": data }),
        );
    }
}

fn ctl_error_answer(e: crate::control_local::CtlError) -> Answer {
    Answer {
        status: 409,
        body: json!({ "error": { "code": e.code, "message": e.message } }).to_string(),
    }
}

/// The pane `target` names in the call's Workspace, read in Rust.
fn resolve_in_rust(app: &AppHandle, caller: &Caller, scope: &Scope, target: &Target) -> Result<String, Answer> {
    let store = app.state::<crate::workspace_store::WorkspaceStore>();
    let ptys = app.state::<crate::pty_manager::PtyManager>();
    let status = app.state::<std::sync::Arc<crate::status_store::StatusStore>>();
    let facts = app.state::<crate::pane_facts::PaneFactsStore>();
    let live = AppLive { app, store: &store, ptys: &ptys, status: &status, facts: &facts };
    crate::control_local::resolve(&live, caller, &scope.workspace_id, target).map_err(ctl_error_answer)
}

/// A call Rust answers itself (`control_local.rs`). A Workspace Opened
/// nowhere is first opened by the Window, in the background, as before.
fn handle_in_rust(app: &AppHandle, caller: &Caller, scope: &Scope, request: &Request) -> Answer {
    if scope.open {
        let open = json!({ "op": "workspace.open" });
        match ask_window(app, caller, scope, &open, Some(PLAIN_REPLY_TIMEOUT)) {
            Ok(reply) if reply.get("error").is_some() => return answer_from_reply(reply),
            Ok(_) => {}
            Err(answer) => return answer,
        }
    }
    let (limit, wait_target) = match request {
        Request::AgentWait { target, timeout_ms, .. }
        | Request::AgentPrompt { target, wait: true, timeout_ms, .. } => {
            (timeout_ms.map(Duration::from_millis), Some(target))
        }
        _ => (None, None),
    };
    // A wait refuses a loop first, as the Window path does.
    let Some(graph) = app.try_state::<WaitGraph>() else {
        return error_answer(503, "unavailable", "Agent control is not ready");
    };
    let wait_id = uuid::Uuid::new_v4().to_string();
    if let Some(target) = wait_target {
        let target_pane = match resolve_in_rust(app, caller, scope, target) {
            Ok(p) => p,
            Err(answer) => return answer,
        };
        if !graph.try_add(&wait_id, &caller.pane_id, &target_pane) {
            return error_answer(
                409,
                "cycle",
                "that Agent is already waiting on you (directly or through others), so this wait would never end",
            );
        }
    }
    let Some(pending) = app.try_state::<PendingRequests>() else {
        graph.remove(&wait_id);
        return error_answer(503, "unavailable", "Agent control is not ready");
    };
    // An interrupted CLI cancels the call through its pending entry.
    let (id, cancel) = pending.register(&scope.window_label);
    if let Some(client) = &scope.client_id {
        pending.track_client(client, &id, &caller.pty_id, &scope.window_label);
    }
    let store = app.state::<crate::workspace_store::WorkspaceStore>();
    let ptys = app.state::<crate::pty_manager::PtyManager>();
    let status = app.state::<std::sync::Arc<crate::status_store::StatusStore>>();
    let facts = app.state::<crate::pane_facts::PaneFactsStore>();
    let live = AppLive { app, store: &store, ptys: &ptys, status: &status, facts: &facts };
    let effects = WindowEffects { app, window_label: &scope.window_label };
    let outcome = crate::control_local::run(&live, &effects, caller, &scope.workspace_id, request, &cancel, limit);
    if let Some(client) = &scope.client_id {
        pending.untrack_client(client, &caller.pty_id, &id);
    }
    pending.forget(&id);
    graph.remove(&wait_id);
    match outcome {
        Ok(Ok(v)) => Answer { status: 200, body: v.to_string() },
        Ok(Err(e)) => ctl_error_answer(e),
        Err(crate::control_local::WaitStop::Cancelled) => {
            error_answer(409, "cancelled", "the call was interrupted")
        }
        Err(crate::control_local::WaitStop::TimedOut) => error_answer(
            504,
            "timeout",
            "no answer in time; the action may still have happened, so check before retrying",
        ),
    }
}

/// Carry out one parsed request for `caller`. `retry` is set when the CLI is
/// sending the same command again after the connection dropped mid-call.
pub fn handle(
    app: &AppHandle,
    caller: &Caller,
    scope: &Scope,
    request: Request,
    retry: bool,
) -> Answer {
    if let Request::WorkspaceList = request {
        return workspace_list_answer(app, caller);
    }
    let request = match (retry, request) {
        // The prompt reached the Window the first time; only wait again.
        (
            true,
            Request::AgentPrompt {
                target,
                wait: true,
                timeout_ms,
                ..
            },
        ) => Request::AgentWait {
            target,
            until: Until::Settled,
            timeout_ms,
        },
        (true, r) if is_mutating(&r) => {
            return error_answer(
                409,
                "connection_lost",
                "the connection dropped during this call, so it may already have happened; check before running it again",
            )
        }
        (_, r) => r,
    };

    if crate::control_local::handles(&request) {
        return handle_in_rust(app, caller, scope, &request);
    }

    let wait = match &request {
        Request::AgentWait {
            target, timeout_ms, ..
        } => Some((target.clone(), *timeout_ms)),
        Request::AgentPrompt {
            target,
            wait: true,
            timeout_ms,
            ..
        } => Some((target.clone(), *timeout_ms)),
        Request::PaneWatch {
            target, timeout_ms, ..
        } => Some((target.clone(), *timeout_ms)),
        _ => None,
    };
    let value = match serde_json::to_value(&request) {
        Ok(v) => v,
        Err(e) => return error_answer(500, "internal", &e.to_string()),
    };

    let Some((target, timeout_ms)) = wait else {
        return match ask_window(app, caller, scope, &value, Some(PLAIN_REPLY_TIMEOUT)) {
            Ok(reply) => answer_from_reply(reply),
            Err(answer) => answer,
        };
    };

    // A wait: learn the target's pane, refuse a loop, then wait.
    let target_pane = match resolve_in_rust(app, caller, scope, &target) {
        Ok(p) => p,
        Err(answer) => return answer,
    };
    let Some(graph) = app.try_state::<WaitGraph>() else {
        return error_answer(503, "unavailable", "Agent control is not ready");
    };
    let wait_id = uuid::Uuid::new_v4().to_string();
    if !graph.try_add(&wait_id, &caller.pane_id, &target_pane) {
        return error_answer(
            409,
            "cycle",
            "that Agent is already waiting on you (directly or through others), so this wait would never end",
        );
    }
    let answer = match ask_window(app, caller, scope, &value, timeout_ms.map(Duration::from_millis)) {
        Ok(reply) => answer_from_reply(reply),
        Err(answer) => answer,
    };
    graph.remove(&wait_id);
    answer
}

/// Serve one `/control` request. Runs on its own thread: the hook server's
/// accept loop is sequential, and a wait may last 30 minutes.
fn token_of(request: &tiny_http::Request) -> String {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv("X-Abundio-Agent-Token"))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default()
}

/// Answer a `/control` request at once, before a thread is spawned or its
/// body read, when its token belongs to no live pane. Returns the request
/// back when the token is known.
pub fn refuse_unknown(app: &AppHandle, request: tiny_http::Request) -> Option<tiny_http::Request> {
    let known = app
        .try_state::<crate::pty_manager::PtyManager>()
        .and_then(|mgr| mgr.control_tokens().lookup(&token_of(&request)))
        .is_some();
    if known {
        return Some(request);
    }
    let answer = error_answer(403, "unauthorized", "not running inside an Abundio pane");
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("static header");
    let _ = request.respond(
        tiny_http::Response::from_string(answer.body)
            .with_status_code(answer.status)
            .with_header(header),
    );
    None
}

pub fn serve(app: AppHandle, mut request: tiny_http::Request) {
    const MAX_BODY: u64 = 1024 * 1024;
    let token = token_of(&request);
    let retry = request
        .headers()
        .iter()
        .any(|h| h.field.equiv("X-Abundio-Retry"));
    let header = |name: &'static str| {
        request
            .headers()
            .iter()
            .find(|h| h.field.equiv(name))
            .map(|h| h.value.as_str().to_string())
            .filter(|v| !v.is_empty() && v.len() <= 64)
    };
    let client_id = header("X-Abundio-Request-Id");
    let cancel = header("X-Abundio-Cancel");
    let mut body = Vec::new();
    let _ = request
        .as_reader()
        .take(MAX_BODY + 1)
        .read_to_end(&mut body);

    let (answer, log) = match cancel {
        Some(c) => serve_cancel(&app, &token, &c),
        None => serve_inner(&app, &token, &body, retry, client_id),
    };
    let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z");
    // Never the prompt or the text read: only who did what, and how it went.
    eprintln!("[{ts}] [abundio:control] {log} status={}", answer.status);

    let content_type = if answer.status == 200 && !answer.body.starts_with('{') {
        "text/plain; charset=utf-8"
    } else {
        "application/json"
    };
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes())
        .expect("static header");
    let _ = request.respond(
        tiny_http::Response::from_string(answer.body)
            .with_status_code(answer.status)
            .with_header(header),
    );
}

/// The CLI was interrupted (Ctrl+C, or its process killed politely) while a
/// call waited: end that call, so the wait does not outlive it.
fn serve_cancel(app: &AppHandle, token: &str, client_id: &str) -> (Answer, String) {
    let caller = app
        .try_state::<crate::pty_manager::PtyManager>()
        .and_then(|mgr| mgr.control_tokens().lookup(token));
    let Some(caller) = caller else {
        return (
            error_answer(403, "unauthorized", "not running inside an Abundio pane"),
            "rejected cancel: bad or missing token".into(),
        );
    };
    let done = app
        .try_state::<PendingRequests>()
        .and_then(|p| p.cancel_client(client_id, &caller.pty_id));
    if let Some((window, id)) = &done {
        let _ = app.emit_to(window.as_str(), "agent-control-cancel", json!({ "id": id }));
    }
    (
        Answer {
            status: 200,
            body: json!({ "cancelled": done.is_some() }).to_string(),
        },
        format!("caller={} op=cancel", caller.pane_id),
    )
}

fn serve_inner(
    app: &AppHandle,
    token: &str,
    body: &[u8],
    retry: bool,
    client_id: Option<String>,
) -> (Answer, String) {
    let caller = app
        .try_state::<crate::pty_manager::PtyManager>()
        .and_then(|mgr| mgr.control_tokens().lookup(token));
    let Some(caller) = caller else {
        return (
            error_answer(
                403,
                "unauthorized",
                "not running inside an Abundio pane (no valid ABUNDIO_AGENT_TOKEN)",
            ),
            "rejected: bad or missing token".into(),
        );
    };
    let who = format!("caller={} ws={}", caller.pane_id, caller.workspace_id);
    if body.len() as u64 > 1024 * 1024 {
        return (
            error_answer(413, "too_large", "the arguments are over 1 MB"),
            who,
        );
    }
    let argv = match split_nul_args(body) {
        Ok(a) => a,
        Err(e) => return (error_answer(400, "usage", &e), who),
    };
    let (cwd, argv) = split_cwd(argv);
    let (workspace, argv) = match split_workspace(&argv) {
        Ok(split) => split,
        Err(e) => return (error_answer(400, "usage", &e), format!("{who} op=usage-error")),
    };
    let request = match parse_args(&argv) {
        Ok(Parsed::Help(text)) => {
            return (
                Answer {
                    status: 200,
                    body: text,
                },
                format!("{who} op=help"),
            )
        }
        Ok(Parsed::Request(r)) => r,
        Err(e) => return (error_answer(400, "usage", &e), format!("{who} op=usage-error")),
    };
    let op = op_name(&request);
    let on = app
        .try_state::<crate::workspace_store::WorkspaceStore>()
        .map(|s| enabled(&s))
        .unwrap_or(false);
    if !on {
        return (
            error_answer(
                403,
                "disabled",
                "Agent control is turned off (Settings ▸ Agents ▸ Let agents control panes)",
            ),
            format!("{who} op={op}"),
        );
    }
    if let Some(answer) = refuse_workspace_flag(&request, workspace.as_deref()) {
        return (answer, format!("{who} op=usage-error"));
    }
    let scope = match &request {
        Request::WorkspaceClose { name, .. } => close_scope(app, &caller, name),
        _ => resolve_scope(app, &caller, workspace.as_deref()),
    };
    let scope = match scope {
        Ok(s) => Scope { client_id, ..s },
        Err(answer) => return (answer, format!("{who} op={op} target=?")),
    };
    // A file to show: resolved and checked here, so the Window never sees a
    // path outside the Workspace (ADR-0058).
    let request = match request {
        Request::FileOpen {
            path,
            window,
            focus,
            line,
            diff,
            preview,
            commit,
            ..
        } => {
            let root = app
                .try_state::<crate::workspace_store::WorkspaceStore>()
                .and_then(|s| s.root_folder_of(&scope.workspace_id).ok().flatten());
            let Some(root) = root else {
                return (
                    error_answer(409, "not_found", "that Workspace no longer exists"),
                    format!("{who} op={op}"),
                );
            };
            match resolve_workspace_file(
                Path::new(&root),
                file_base(&scope.workspace_id, &caller.workspace_id, cwd.as_deref()),
                &path,
                commit.is_none(),
            ) {
                Ok((path, rel)) => Request::FileOpen {
                    path,
                    rel,
                    window,
                    focus,
                    line,
                    diff,
                    preview,
                    commit,
                },
                Err((code, message)) => {
                    return (error_answer(400, code, &message), format!("{who} op={op}"))
                }
            }
        }
        other => other,
    };
    let target = if scope.workspace_id == caller.workspace_id {
        String::new()
    } else {
        format!(" target={}{}", scope.workspace_id, if scope.open { " opening" } else { "" })
    };
    let answer = handle(app, &caller, &scope, request, retry);
    (
        answer,
        format!("{who} op={op}{target}{}", if retry { " retry" } else { "" }),
    )
}

// ── Commands ──

/// A pane closed: tell every Window (ADR-0055). Its **Spawned panes** may
/// sit in other Workspaces, opened in other Windows, and
/// only each Window may edit its own Workspaces' layouts.
/// Only a Profile window holds panes, so any other window is ignored.
#[tauri::command]
pub fn agent_control_pane_closed(
    app: AppHandle,
    window: tauri::Window,
    pane_id: String,
) -> Result<(), crate::error::AbundioError> {
    if !crate::window_management::is_profile_window_label(window.label()) {
        return Ok(());
    }
    let _ = app.emit("agent-control-pane-closed", json!({ "paneId": pane_id }));
    Ok(())
}

/// A Window's answer to an `agent-control-request`. Only the Window the
/// request was sent to may answer it.
#[tauri::command]
pub fn agent_control_reply(
    window: tauri::Window,
    pending: tauri::State<'_, PendingRequests>,
    id: String,
    reply: Value,
) -> Result<bool, crate::error::AbundioError> {
    Ok(pending.reply_from(window.label(), &id, reply))
}





// ── What Agent control reads and writes in the app (control_local.rs) ──

/// A Tab's layout edit Rust makes itself (Agent control): applied, saved,
/// and sent to every Window of the Profile, the owning one included.
pub fn apply_from_rust(
    app: &tauri::AppHandle,
    tab_id: &str,
    ops: &[crate::layout_ops::LayoutOp],
) -> Result<crate::layout_store::LayoutState, crate::error::AbundioError> {
    use crate::event_sink::EventsExt;
    use tauri::Manager;
    let layouts = app.state::<std::sync::Arc<crate::layout_store::LayoutStore>>();
    let db = app.state::<crate::workspace_store::WorkspaceStore>();
    let ptys = app.state::<crate::pty_manager::PtyManager>();
    let applied = layouts.apply(&db, tab_id, ops, &|id| ptys.is_live(id))?;
    if applied.changed {
        let events = app.state::<crate::event_sink::Events>();
        let profiles = app.state::<crate::profile_store::ActiveProfileState>();
        for client in crate::layout_store::broadcast_targets(&profiles.snapshot(), &applied.profile_id, &crate::event_sink::ClientId(String::new())) {
            events.to_client(&client, "layout-changed", &applied.state);
        }
    }
    Ok(applied.state)
}


// ── The app's live state ──

pub struct AppLive<'a> {
    pub app: &'a tauri::AppHandle,
    pub store: &'a crate::workspace_store::WorkspaceStore,
    pub ptys: &'a crate::pty_manager::PtyManager,
    pub status: &'a crate::status_store::StatusStore,
    pub facts: &'a crate::pane_facts::PaneFactsStore,
}

impl crate::control_local::Live for AppLive<'_> {
    fn workspaces(&self, caller_workspace: &str) -> Result<Vec<WorkspaceWithTabs>, AbundioError> {
        let Some(profile) = self.store.profile_of(caller_workspace)? else {
            return Ok(Vec::new());
        };
        self.store.list(&profile)
    }
    fn pane_numbers(&self, workspace_id: &str, pane_ids: &[String]) -> Result<Vec<(String, u32)>, AbundioError> {
        self.store.pane_numbers(workspace_id, pane_ids)
    }
    fn view(&self, pty_id: &str) -> Option<StoreView> {
        self.status.view(pty_id)
    }
    fn is_live(&self, pty_id: &str) -> bool {
        self.ptys.is_live(pty_id)
    }
    fn facts(&self, pane_id: &str) -> PaneFacts {
        self.facts.get(pane_id)
    }
    fn read_screen(&self, pty_id: &str, visible: bool, lines: Option<usize>) -> Result<Vec<String>, AbundioError> {
        self.ptys.read_screen(pty_id, visible, lines)
    }
    fn input_modes(&self, pty_id: &str) -> Option<crate::screen::InputModes> {
        self.ptys.input_modes(pty_id)
    }
    fn write(&self, pty_id: &str, bytes: &[u8]) -> Result<(), AbundioError> {
        self.ptys.write(pty_id, bytes.to_vec())
    }
    fn check_handle(&self, workspace_id: &str, pane_id: &str, handle: &str) -> Result<crate::agent_names::HandleCheck, AbundioError> {
        use tauri::Manager;
        let r = self.app.state::<crate::agent_names::HandleReservations>();
        r.check(self.store, workspace_id, pane_id, handle)
    }
    fn take_default_handle(&self, workspace_id: &str, pane_id: &str) -> Result<String, AbundioError> {
        use tauri::Manager;
        let r = self.app.state::<crate::agent_names::HandleReservations>();
        r.take_default(self.store, workspace_id, pane_id)
    }
    fn patch_pane(&self, tab_id: &str, pane_id: &str, set: serde_json::Map<String, Value>) -> Result<(), AbundioError> {
        let op = crate::layout_ops::LayoutOp::Patch { id: pane_id.to_string(), set, unset: vec![] };
        let state = apply_from_rust(self.app, tab_id, &[op])?;
        if !state.applied {
            return Err(AbundioError::NotFound(state.reason.unwrap_or_else(|| "that pane closed".into())));
        }
        Ok(())
    }
    fn rename_tab(&self, workspace_id: &str, tab_id: &str, name: &str) -> Result<(), AbundioError> {
        use tauri::Manager;
        self.store.update_tab(
            tab_id,
            crate::workspace_store::TabUpdate { name: Some(name.to_string()), ..Default::default() },
        )?;
        if let Some(profile) = self.store.profile_of(workspace_id)? {
            crate::host_api::send_tabs_changed(
                self.store,
                &self.app.state::<crate::profile_store::ActiveProfileState>().snapshot(),
                &self.app.state::<crate::event_sink::Events>(),
                None,
                workspace_id,
                &profile,
            );
        }
        Ok(())
    }
}

/// The hook server's view of the desktop app (`hook_server::HookHost`).
pub struct AppHookHost(pub AppHandle);

impl crate::hook_server::HookHost for AppHookHost {
    /// Applied here, where the PTY runs (phase 6d): the owning Window gets
    /// what it keeps besides the status (`agent-hook-applied`), then the
    /// status (`status-updates`), in that order, as it did them.
    fn hook_event(&self, pty_id: &str, event: crate::events::AgentHookEvent) {
        use crate::event_sink::EventsExt;
        let status = self.0.state::<std::sync::Arc<crate::status_store::StatusStore>>();
        let applied = crate::hook_apply::apply(
            &status,
            pty_id,
            &event.agent,
            &event.event,
            &event.payload,
            crate::hook_apply::now_ms(),
            &crate::status_machine::StatusConfig::default(),
        );
        let client = status.owner(pty_id).or_else(|| {
            self.0
                .state::<crate::pty_manager::PtyManager>()
                .owner_window(pty_id)
                .map(crate::event_sink::ClientId)
        });
        let Some(client) = client else { return };
        let events = self.0.state::<crate::event_sink::Events>();
        events.to_client(&client, "agent-hook-applied", &applied.notice);
        if !applied.updates.is_empty() {
            events.to_client(&client, "status-updates", applied.updates);
        }
    }
    fn ptys(&self) -> Option<&crate::pty_manager::PtyManager> {
        self.0.try_state::<crate::pty_manager::PtyManager>().map(|s| s.inner())
    }
    fn env_store(&self) -> Option<&crate::env_vars::EnvVarStore> {
        self.0.try_state::<crate::env_vars::EnvVarStore>().map(|s| s.inner())
    }
    fn control_refuse_unknown(&self, request: tiny_http::Request) -> Option<tiny_http::Request> {
        refuse_unknown(&self.0, request)
    }
    fn control_serve(&self, request: tiny_http::Request) {
        serve(self.0.clone(), request)
    }
}

// ── Agent handle commands (agent_names.rs) ──

// ── Commands ──



