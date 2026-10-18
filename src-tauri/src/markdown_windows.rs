//! **Markdown windows**: Workspace-bound Windows that show one markdown file,
//! rendered or as source. See the `Markdown window` and `Workspace-bound
//! window` entries in GLOSSARY.md, and ADR-0046.
//!
//! ## What a row means
//!
//! A row exists while its window is open *and* while it is remembered. Closes
//! driven by the owner (Workspace close, Profile switch, owning Window close,
//! quit) keep the row, so the window reopens when the Workspace is next opened.
//! A window the user closes themselves deletes its row.
//!
//! The `label` is generated once and kept for the life of the row, because
//! `tauri-plugin-window-state` keys the saved size and position by label.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use uuid::Uuid;

use crate::error::AbundioError;

/// Every Markdown window label starts with this. `md-<uuid>`.
pub const MARKDOWN_WINDOW_PREFIX: &str = "md-";

/// Which of its two views a Markdown window shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarkdownView {
    Rendered,
    Source,
}

impl MarkdownView {
    fn as_str(&self) -> &'static str {
        match self {
            MarkdownView::Rendered => "rendered",
            MarkdownView::Source => "source",
        }
    }

    /// Unknown values read as `Rendered`: a row written by a newer build should
    /// still open, in the safe read-only view.
    fn from_str(s: &str) -> Self {
        match s {
            "source" => MarkdownView::Source,
            _ => MarkdownView::Rendered,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownWindowRow {
    pub workspace_id: String,
    pub file_path: String,
    pub label: String,
    pub view: MarkdownView,
}

pub fn new_label() -> String {
    format!("{}{}", MARKDOWN_WINDOW_PREFIX, Uuid::new_v4())
}

pub fn is_markdown_window_label(label: &str) -> bool {
    label.starts_with(MARKDOWN_WINDOW_PREFIX)
}

/// What a Markdown window needs to know about its Workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceMeta {
    pub name: String,
    pub root_folder: String,
    pub profile_id: String,
}

/// Sent to a Markdown window that should save its buffer. It answers by
/// reporting itself clean through `md_window_set_dirty`.
pub const MARKDOWN_WINDOW_SAVE: &str = "markdown-window-save";

/// The file a Markdown window may show: an existing markdown file inside the
/// Workspace folder. Both sides are canonicalised, so `..` and symlinks cannot
/// walk out of the folder. Checked in Rust, not only in the UI, because the IPC
/// is downstream of every entry point.
pub fn validate_markdown_path(root_folder: &str, file_path: &str) -> Result<PathBuf, AbundioError> {
    let root = Path::new(root_folder).canonicalize()?;
    let path = Path::new(file_path).canonicalize()?;
    if !path.starts_with(&root) {
        return Err(AbundioError::InvalidOperation(
            "File is outside the Workspace folder".into(),
        ));
    }
    if !path.is_file() || !is_markdown_path(&path) {
        return Err(AbundioError::InvalidOperation("Not a markdown file".into()));
    }
    Ok(path)
}

/// What restoring should do with a remembered row.
#[derive(Debug, PartialEq, Eq)]
pub enum RestoreCheck {
    /// The file is there: reopen it. Carries the canonical path.
    Reopen(String),
    /// The file is gone, or is no longer a markdown file inside the folder:
    /// forget the window, quietly.
    Forget,
    /// The Workspace folder cannot be reached, or the file cannot be read for
    /// some other reason (an unmounted drive, permissions). Keep the row and
    /// try again next time: the user never closed this window.
    Keep,
}

/// Decides a remembered row's fate. Only a file that is *known* to be gone
/// forgets the window; any doubt keeps it.
pub fn check_restore(root_folder: &str, file_path: &str) -> RestoreCheck {
    let Ok(root) = Path::new(root_folder).canonicalize() else {
        return RestoreCheck::Keep;
    };
    match Path::new(file_path).canonicalize() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => RestoreCheck::Forget,
        Err(_) => RestoreCheck::Keep,
        Ok(path) if path.starts_with(&root) && path.is_file() && is_markdown_path(&path) => {
            RestoreCheck::Reopen(path.to_string_lossy().into_owned())
        }
        Ok(_) => RestoreCheck::Forget,
    }
}

/// A path in the platform's own separators, the spelling the file watcher
/// reports. A link resolved in the frontend arrives with `/` even on Windows.
pub fn native_spelling(path: &str) -> String {
    Path::new(path)
        .components()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned()
}

/// Same rule as `isMarkdownFile` in the frontend: `.md` or `.mdx`.
fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("mdx"))
        .unwrap_or(false)
}

pub fn window_title(file_path: &str, workspace_name: &str) -> String {
    let file_name = Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(file_path);
    format!("{file_name} — {workspace_name}")
}

// ── Store ──

pub struct MarkdownWindowStore {
    conn: Mutex<Connection>,
    /// Labels of open Markdown windows with unsaved edits. Each window reports
    /// its own state; the owning Window cannot see into another webview, so it
    /// asks here before closing a Workspace (ADR-0046). In memory only: an
    /// unsaved buffer does not survive the window anyway.
    dirty: Mutex<HashSet<String>>,
}

impl MarkdownWindowStore {
    pub fn new(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
            dirty: Mutex::new(HashSet::new()),
        }
    }

    pub fn set_dirty(&self, label: &str, dirty: bool) {
        let mut set = self.dirty.lock().unwrap();
        if dirty {
            set.insert(label.to_string());
        } else {
            set.remove(label);
        }
    }

    pub fn is_dirty(&self, label: &str) -> bool {
        self.dirty.lock().unwrap().contains(label)
    }

    pub fn workspace_meta(&self, workspace_id: &str) -> Result<Option<WorkspaceMeta>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT name, root_folder, profile_id FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |r| {
                Ok(WorkspaceMeta {
                    name: r.get(0)?,
                    root_folder: r.get(1)?,
                    profile_id: r.get(2)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    /// Labels of every Markdown window whose Workspace is in this Profile.
    pub fn labels_for_profile(&self, profile_id: &str) -> Result<Vec<String>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT m.label FROM markdown_windows m
             JOIN workspaces w ON w.id = m.workspace_id
             WHERE w.profile_id = ?1",
        )?;
        let rows = stmt.query_map(params![profile_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// The row for this file, created if missing. One window per file: a
    /// second open of the same file finds the first row and so the same label.
    ///
    /// Keyed by `canonical_path`, so every spelling of one file (separators,
    /// symlinked folders, case on a case-insensitive disk) finds the same row.
    /// `file_path` is kept as the first opener spelled it.
    pub fn upsert(
        &self,
        workspace_id: &str,
        file_path: &str,
        canonical_path: &str,
    ) -> Result<MarkdownWindowRow, AbundioError> {
        let conn = self.conn.lock().unwrap();
        // `INSERT OR IGNORE` then read back, under one lock, so two opens of the
        // same file can never mint two labels.
        conn.execute(
            "INSERT OR IGNORE INTO markdown_windows
               (workspace_id, file_path, canonical_path, label)
             VALUES (?1, ?2, ?3, ?4)",
            params![workspace_id, file_path, canonical_path, new_label()],
        )?;
        let row = conn.query_row(
            "SELECT workspace_id, file_path, label, view FROM markdown_windows
             WHERE workspace_id = ?1 AND canonical_path = ?2",
            params![workspace_id, canonical_path],
            read_row,
        )?;
        Ok(row)
    }

    /// Records a row's canonical path. `false` when another row of the same
    /// Workspace already has it: this row is a duplicate spelling of that file.
    pub fn set_canonical(&self, label: &str, canonical_path: &str) -> Result<bool, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "UPDATE OR IGNORE markdown_windows SET canonical_path = ?1 WHERE label = ?2",
            params![canonical_path, label],
        )?;
        Ok(changed > 0)
    }

    pub fn find_by_label(&self, label: &str) -> Result<Option<MarkdownWindowRow>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT workspace_id, file_path, label, view FROM markdown_windows
             WHERE label = ?1",
            params![label],
            read_row,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn list_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<MarkdownWindowRow>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT workspace_id, file_path, label, view FROM markdown_windows
             WHERE workspace_id = ?1
             ORDER BY created_at ASC, file_path ASC",
        )?;
        let rows = stmt.query_map(params![workspace_id], read_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Every row, across Workspaces. Used to find the windows of a Profile.
    pub fn list_all(&self) -> Result<Vec<MarkdownWindowRow>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT workspace_id, file_path, label, view FROM markdown_windows
             ORDER BY created_at ASC, file_path ASC",
        )?;
        let rows = stmt.query_map([], read_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn set_view(&self, label: &str, view: MarkdownView) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE markdown_windows SET view = ?1 WHERE label = ?2",
            params![view.as_str(), label],
        )?;
        Ok(())
    }

    /// Forgets a window. A missing row is not an error: forgetting twice is
    /// what a close racing a Workspace delete looks like.
    pub fn delete_by_label(&self, label: &str) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM markdown_windows WHERE label = ?1", params![label])?;
        Ok(())
    }
}

// ── Windows ──

/// Focuses the row's window if it is open, or builds it. The stored label is
/// reused so the window-state plugin restores its size and position.
pub fn open_or_focus(
    app: &AppHandle<Wry>,
    row: &MarkdownWindowRow,
    meta: &WorkspaceMeta,
) -> Result<(), AbundioError> {
    if let Some(existing) = app.get_webview_window(&row.label) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }
    build_window(app, row, meta, true)
}

/// Builds the row's window. `focus: false` opens it behind the current one.
fn build_window(
    app: &AppHandle<Wry>,
    row: &MarkdownWindowRow,
    meta: &WorkspaceMeta,
    focus: bool,
) -> Result<(), AbundioError> {
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = WebviewWindowBuilder::new(
        app,
        &row.label,
        WebviewUrl::App("index.html?markdown".into()),
    )
    .title(window_title(&row.file_path, &meta.name))
    .inner_size(880.0, 760.0)
    .min_inner_size(420.0, 320.0)
    .resizable(true)
    .focused(focus);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    builder.build().map_err(|e| {
        AbundioError::InvalidOperation(format!("Markdown window build failed: {e}"))
    })?;
    Ok(())
}

/// Closes these windows on their owner's behalf, so their rows are kept and
/// they reopen with the Workspace. `destroy`, not `close`: the owner has
/// already asked about unsaved edits, and `destroy` skips the window's own
/// close handler — which is the one place a row is forgotten.
pub fn destroy_remembered(app: &AppHandle<Wry>, labels: &[String]) {
    for label in labels {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
}

/// Cleans up after a Markdown window's `Destroyed`. Its row is untouched.
pub fn on_destroyed(app: &AppHandle<Wry>, label: &str) {
    if let Some(store) = app.try_state::<MarkdownWindowStore>() {
        store.set_dirty(label, false);
    }
}

/// Closes, and remembers, the Markdown windows of a Profile. Called when the
/// Profile's Window is destroyed, because React cleanup never runs then.
pub fn destroy_for_profile(app: &AppHandle<Wry>, profile_id: &str) {
    let Some(store) = app.try_state::<MarkdownWindowStore>() else {
        return;
    };
    match store.labels_for_profile(profile_id) {
        Ok(labels) => destroy_remembered(app, &labels),
        Err(e) => eprintln!("[abundio] markdown windows for profile: {e}"),
    }
}

fn labels_for_workspaces(
    store: &MarkdownWindowStore,
    workspace_ids: &[String],
) -> Result<Vec<String>, AbundioError> {
    let mut labels = Vec::new();
    for id in workspace_ids {
        labels.extend(store.list_for_workspace(id)?.into_iter().map(|r| r.label));
    }
    Ok(labels)
}

fn row_for_caller(
    store: &MarkdownWindowStore,
    window: &WebviewWindow,
) -> Result<MarkdownWindowRow, AbundioError> {
    store
        .find_by_label(window.label())?
        .ok_or_else(|| AbundioError::NotFound(format!("markdown window {}", window.label())))
}

// ── IPC ──

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownWindowInfo {
    pub workspace_id: String,
    pub workspace_name: String,
    pub root_folder: String,
    pub file_path: String,
    pub view: MarkdownView,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyMarkdownWindow {
    pub label: String,
    pub file_path: String,
}

/// Opens a markdown file of a Workspace in its Markdown window, or focuses the
/// one already showing it.
#[tauri::command]
pub async fn md_window_open(
    app: AppHandle,
    store: State<'_, MarkdownWindowStore>,
    workspace_id: String,
    file_path: String,
) -> Result<(), AbundioError> {
    let meta = store
        .workspace_meta(&workspace_id)?
        .ok_or_else(|| AbundioError::NotFound(format!("workspace {workspace_id}")))?;
    let canonical = validate_markdown_path(&meta.root_folder, &file_path)?;
    // Keyed by the canonical path, so a link and the explorer, which spell
    // one file differently, share one window. The shown path keeps the
    // caller's spelling in native separators, which is what the explorer,
    // File panes and the file watcher use.
    let row = store.upsert(
        &workspace_id,
        &native_spelling(&file_path),
        &canonical.to_string_lossy(),
    )?;
    open_or_focus(&app, &row, &meta)
}

/// The calling Markdown window's file and Workspace. Read by label, never from
/// the URL, so a window cannot be pointed at a file by its own query string.
#[tauri::command]
pub async fn md_window_info(
    window: WebviewWindow,
    store: State<'_, MarkdownWindowStore>,
) -> Result<MarkdownWindowInfo, AbundioError> {
    let row = row_for_caller(&store, &window)?;
    let meta = store
        .workspace_meta(&row.workspace_id)?
        .ok_or_else(|| AbundioError::NotFound(format!("workspace {}", row.workspace_id)))?;
    Ok(MarkdownWindowInfo {
        workspace_id: row.workspace_id,
        workspace_name: meta.name,
        root_folder: meta.root_folder,
        file_path: row.file_path,
        view: row.view,
    })
}

#[tauri::command]
pub async fn md_window_set_view(
    window: WebviewWindow,
    store: State<'_, MarkdownWindowStore>,
    view: MarkdownView,
) -> Result<(), AbundioError> {
    store.set_view(window.label(), view)
}

#[tauri::command]
pub async fn md_window_set_dirty(
    window: WebviewWindow,
    store: State<'_, MarkdownWindowStore>,
    dirty: bool,
) -> Result<(), AbundioError> {
    if is_markdown_window_label(window.label()) {
        store.set_dirty(window.label(), dirty);
    }
    Ok(())
}

/// Forgets the calling window: the user closed it themselves.
#[tauri::command]
pub async fn md_window_forget(
    window: WebviewWindow,
    store: State<'_, MarkdownWindowStore>,
) -> Result<(), AbundioError> {
    store.delete_by_label(window.label())
}

/// The open Markdown windows of these Workspaces that have unsaved edits.
#[tauri::command]
pub async fn md_windows_dirty(
    app: AppHandle,
    store: State<'_, MarkdownWindowStore>,
    workspace_ids: Vec<String>,
) -> Result<Vec<DirtyMarkdownWindow>, AbundioError> {
    let mut rows = Vec::new();
    for id in &workspace_ids {
        rows.extend(store.list_for_workspace(id)?);
    }
    Ok(dirty_windows(
        rows,
        |l| store.is_dirty(l),
        |l| app.get_webview_window(l).is_some(),
    ))
}

/// The rows whose window is open and has unsaved edits. A dirty flag can
/// outlive its window by a moment (it is cleared on `Destroyed`), so both are
/// required.
pub fn dirty_windows(
    rows: Vec<MarkdownWindowRow>,
    is_dirty: impl Fn(&str) -> bool,
    is_open: impl Fn(&str) -> bool,
) -> Vec<DirtyMarkdownWindow> {
    rows.into_iter()
        .filter(|r| is_dirty(&r.label) && is_open(&r.label))
        .map(|r| DirtyMarkdownWindow {
            label: r.label,
            file_path: r.file_path,
        })
        .collect()
}

/// Asks these windows to save. Each answers by reporting itself clean.
#[tauri::command]
pub async fn md_windows_save(app: AppHandle, labels: Vec<String>) -> Result<(), AbundioError> {
    for label in labels.iter().filter(|l| is_markdown_window_label(l)) {
        let _ = app.emit_to(label.as_str(), MARKDOWN_WINDOW_SAVE, ());
    }
    Ok(())
}

/// Closes the Markdown windows of these Workspaces and remembers them.
#[tauri::command]
pub async fn md_windows_close(
    app: AppHandle,
    store: State<'_, MarkdownWindowStore>,
    workspace_ids: Vec<String>,
) -> Result<(), AbundioError> {
    let labels = labels_for_workspaces(&store, &workspace_ids)?;
    destroy_remembered(&app, &labels);
    Ok(())
}

/// Reopens a Workspace's remembered Markdown windows. A row whose file is gone
/// (or no longer a markdown file inside the folder) is dropped quietly.
#[tauri::command]
pub async fn md_windows_restore(
    app: AppHandle,
    store: State<'_, MarkdownWindowStore>,
    workspace_id: String,
) -> Result<(), AbundioError> {
    let Some(meta) = store.workspace_meta(&workspace_id)? else {
        return Ok(());
    };
    for row in store.list_for_workspace(&workspace_id)? {
        match check_restore(&meta.root_folder, &row.file_path) {
            RestoreCheck::Keep => continue,
            RestoreCheck::Forget => {
                store.delete_by_label(&row.label)?;
                continue;
            }
            RestoreCheck::Reopen(canonical) => {
                // A row from before the canonical key may duplicate another
                // spelling of the same file; keep only the first.
                if !store.set_canonical(&row.label, &canonical)? {
                    store.delete_by_label(&row.label)?;
                    continue;
                }
            }
        }
        if let Err(e) = open_or_focus_unfocused(&app, &row, &meta) {
            eprintln!("[abundio] reopen markdown window {}: {e}", row.label);
        }
    }
    Ok(())
}

/// Restoring opens windows without stealing focus: the user is working in the
/// Profile window that just opened the Workspace.
fn open_or_focus_unfocused(
    app: &AppHandle<Wry>,
    row: &MarkdownWindowRow,
    meta: &WorkspaceMeta,
) -> Result<(), AbundioError> {
    if app.get_webview_window(&row.label).is_some() {
        return Ok(());
    }
    build_window(app, row, meta, false)
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MarkdownWindowRow> {
    Ok(MarkdownWindowRow {
        workspace_id: row.get(0)?,
        file_path: row.get(1)?,
        label: row.get(2)?,
        view: MarkdownView::from_str(&row.get::<_, String>(3)?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(workspaces: &[&str]) -> MarkdownWindowStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        for id in workspaces {
            conn.execute(
                "INSERT INTO workspaces (id, name, root_folder) VALUES (?1, 'W', '/tmp')",
                [id],
            )
            .unwrap();
        }
        MarkdownWindowStore::new(conn)
    }

    #[test]
    fn upsert_creates_a_rendered_row_with_an_md_label() {
        let s = store_with(&["w1"]);
        let row = s.upsert("w1", "/tmp/README.md", "/tmp/README.md").unwrap();
        assert!(row.label.starts_with(MARKDOWN_WINDOW_PREFIX));
        assert_eq!(row.view, MarkdownView::Rendered);
        assert_eq!(row.file_path, "/tmp/README.md");
    }

    #[test]
    fn upsert_twice_returns_the_same_label() {
        let s = store_with(&["w1"]);
        let a = s.upsert("w1", "/tmp/a.md", "/tmp/a.md").unwrap();
        let b = s.upsert("w1", "/tmp/a.md", "/tmp/a.md").unwrap();
        assert_eq!(a.label, b.label);
        assert_eq!(s.list_for_workspace("w1").unwrap().len(), 1);
    }

    #[test]
    fn the_same_file_in_two_workspaces_is_two_windows() {
        let s = store_with(&["w1", "w2"]);
        let a = s.upsert("w1", "/tmp/a.md", "/tmp/a.md").unwrap();
        let b = s.upsert("w2", "/tmp/a.md", "/tmp/a.md").unwrap();
        assert_ne!(a.label, b.label);
    }

    #[test]
    fn set_view_is_kept() {
        let s = store_with(&["w1"]);
        let row = s.upsert("w1", "/tmp/a.md", "/tmp/a.md").unwrap();
        s.set_view(&row.label, MarkdownView::Source).unwrap();
        let again = s.upsert("w1", "/tmp/a.md", "/tmp/a.md").unwrap();
        assert_eq!(again.view, MarkdownView::Source);
        assert_eq!(
            s.find_by_label(&row.label).unwrap().unwrap().view,
            MarkdownView::Source
        );
    }

    #[test]
    fn delete_by_label_forgets_and_is_idempotent() {
        let s = store_with(&["w1"]);
        let row = s.upsert("w1", "/tmp/a.md", "/tmp/a.md").unwrap();
        s.delete_by_label(&row.label).unwrap();
        s.delete_by_label(&row.label).unwrap();
        assert!(s.find_by_label(&row.label).unwrap().is_none());
    }

    #[test]
    fn deleting_the_workspace_deletes_its_rows() {
        let s = store_with(&["w1", "w2"]);
        s.upsert("w1", "/tmp/a.md", "/tmp/a.md").unwrap();
        s.upsert("w2", "/tmp/b.md", "/tmp/b.md").unwrap();
        s.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM workspaces WHERE id = 'w1'", [])
            .unwrap();
        assert!(s.list_for_workspace("w1").unwrap().is_empty());
        assert_eq!(s.list_all().unwrap().len(), 1);
    }

    #[test]
    fn unknown_view_reads_as_rendered() {
        assert_eq!(MarkdownView::from_str("split"), MarkdownView::Rendered);
    }
    #[test]
    fn markdown_labels_are_recognised() {
        assert!(is_markdown_window_label(&new_label()));
        assert!(!is_markdown_window_label("main"));
        assert!(!is_markdown_window_label("window-1"));
        assert!(!is_markdown_window_label("settings"));
    }

    #[test]
    fn dirty_is_tracked_per_label() {
        let s = store_with(&[]);
        s.set_dirty("md-a", true);
        assert!(s.is_dirty("md-a"));
        assert!(!s.is_dirty("md-b"));
        s.set_dirty("md-a", false);
        assert!(!s.is_dirty("md-a"));
    }

    #[test]
    fn workspace_meta_and_labels_for_profile() {
        let s = store_with(&["w1"]);
        let meta = s.workspace_meta("w1").unwrap().unwrap();
        assert_eq!(meta.root_folder, "/tmp");
        let row = s.upsert("w1", "/tmp/a.md", "/tmp/a.md").unwrap();
        assert_eq!(s.labels_for_profile(&meta.profile_id).unwrap(), vec![row.label]);
        assert!(s.labels_for_profile("nobody").unwrap().is_empty());
        assert!(s.workspace_meta("missing").unwrap().is_none());
    }

    #[test]
    fn validate_accepts_markdown_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("README.md");
        std::fs::write(&file, "# hi").unwrap();
        let root = dir.path().to_str().unwrap();
        assert!(validate_markdown_path(root, file.to_str().unwrap()).is_ok());
    }

    #[test]
    fn validate_refuses_outside_missing_and_non_markdown() {
        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("ws");
        std::fs::create_dir(&inner).unwrap();
        let outside = dir.path().join("secret.md");
        std::fs::write(&outside, "x").unwrap();
        let text = inner.join("notes.txt");
        std::fs::write(&text, "x").unwrap();
        let root = inner.to_str().unwrap();
        // `..` resolves out of the folder.
        let escaped = inner.join("../secret.md");
        assert!(validate_markdown_path(root, escaped.to_str().unwrap()).is_err());
        assert!(validate_markdown_path(root, text.to_str().unwrap()).is_err());
        let missing = inner.join("gone.md");
        assert!(validate_markdown_path(root, missing.to_str().unwrap()).is_err());
    }

    #[test]
    fn title_names_the_file_and_workspace() {
        assert_eq!(window_title("/repo/docs/README.md", "Repo"), "README.md — Repo");
    }
    #[test]
    fn two_spellings_of_one_file_share_a_row() {
        let s = store_with(&["w1"]);
        let a = s.upsert("w1", "C:\\repo\\a.md", "/canon/a.md").unwrap();
        let b = s.upsert("w1", "C:/repo/a.md", "/canon/a.md").unwrap();
        assert_eq!(a.label, b.label);
        // The first opener's spelling is kept.
        assert_eq!(b.file_path, "C:\\repo\\a.md");
    }

    #[test]
    fn set_canonical_refuses_a_duplicate() {
        let s = store_with(&["w1"]);
        let a = s.upsert("w1", "/tmp/a.md", "/canon/a.md").unwrap();
        let b = s.upsert("w1", "/tmp/link/a.md", "/tmp/link/a.md").unwrap();
        assert!(s.set_canonical(&a.label, "/canon/a.md").unwrap());
        assert!(!s.set_canonical(&b.label, "/canon/a.md").unwrap());
    }

    #[test]
    fn restore_reopens_a_markdown_file_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("README.md");
        std::fs::write(&file, "# hi").unwrap();
        let check = check_restore(dir.path().to_str().unwrap(), file.to_str().unwrap());
        let canonical = file.canonicalize().unwrap();
        assert_eq!(check, RestoreCheck::Reopen(canonical.to_string_lossy().into_owned()));
    }

    #[test]
    fn restore_forgets_a_deleted_file() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("gone.md");
        assert_eq!(
            check_restore(dir.path().to_str().unwrap(), gone.to_str().unwrap()),
            RestoreCheck::Forget
        );
    }

    #[test]
    fn restore_keeps_the_row_when_the_folder_is_unreachable() {
        // An unmounted drive or network share: the root itself is missing.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("unmounted");
        let file = root.join("README.md");
        assert_eq!(
            check_restore(root.to_str().unwrap(), file.to_str().unwrap()),
            RestoreCheck::Keep
        );
    }

    #[test]
    fn restore_forgets_a_file_that_is_no_longer_markdown_or_inside() {
        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("ws");
        std::fs::create_dir(&inner).unwrap();
        let outside = dir.path().join("x.md");
        std::fs::write(&outside, "x").unwrap();
        let folder = inner.join("notes.md");
        std::fs::create_dir(&folder).unwrap();
        let root = inner.to_str().unwrap();
        assert_eq!(
            check_restore(root, inner.join("../x.md").to_str().unwrap()),
            RestoreCheck::Forget
        );
        assert_eq!(check_restore(root, folder.to_str().unwrap()), RestoreCheck::Forget);
    }

    #[test]
    fn native_spelling_drops_doubled_separators() {
        assert_eq!(native_spelling("/repo//docs/./a.md"), "/repo/docs/a.md");
    }

    #[test]
    fn dirty_windows_needs_both_dirty_and_open() {
        let row = |label: &str| MarkdownWindowRow {
            workspace_id: "w1".into(),
            file_path: format!("/r/{label}.md"),
            label: label.into(),
            view: MarkdownView::Rendered,
        };
        let out = dirty_windows(
            vec![row("md-a"), row("md-b"), row("md-c")],
            |l| l != "md-c",
            |l| l != "md-b",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].label, "md-a");
        assert_eq!(out[0].file_path, "/r/md-a.md");
    }
}
