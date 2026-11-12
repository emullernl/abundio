//! **File windows**: Workspace-bound Windows that show one thing a File pane
//! could show — a text file (markdown rendered or as source), an image, a
//! file's live diff, or one file as a commit changed it. See the `File window`
//! and `Workspace-bound window` entries in GLOSSARY.md, ADR-0046 and ADR-0049.
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
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use uuid::Uuid;

use crate::error::AbundioError;
use crate::window_frame::PlacementTracker;
use crate::window_placement::Remembered;

/// Every File window label starts with this: `md-<uuid>`. The prefix dates
/// from when these were Markdown windows. It is kept on purpose (ADR-0049):
/// the label keys each window's saved geometry, and the `markdown-window.json`
/// capability matches it. Do not rename it.
pub const FILE_WINDOW_PREFIX: &str = "md-";

/// What a File window shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileWindowKind {
    /// A text file, editable. Markdown also has a rendered view.
    Text,
    /// An image, read-only.
    Image,
    /// A file's live working-tree diff, read-only.
    Diff,
    /// One file as one commit changed it. Frozen history, read-only.
    CommitDiff,
    /// A kind this build does not know: a row written by a newer build of the
    /// same data epoch. Never opened, never validated, and kept on restore, so
    /// going back to the newer build still finds the window. The IPC cannot
    /// create one: `validate_target` refuses it.
    #[serde(other)]
    Unknown,
}

impl FileWindowKind {
    fn as_str(&self) -> &'static str {
        match self {
            FileWindowKind::Text => "text",
            FileWindowKind::Image => "image",
            FileWindowKind::Diff => "diff",
            FileWindowKind::CommitDiff => "commit-diff",
            // Never written: `validate_target` refuses it before any upsert.
            FileWindowKind::Unknown => "unknown",
        }
    }

    /// Unknown values read as `Unknown`, not as `Text`: reading a newer
    /// kind as text would canonicalise its path as a file and forget the row.
    fn from_str(s: &str) -> Self {
        match s {
            "text" => FileWindowKind::Text,
            "image" => FileWindowKind::Image,
            "diff" => FileWindowKind::Diff,
            "commit-diff" => FileWindowKind::CommitDiff,
            _ => FileWindowKind::Unknown,
        }
    }

    fn is_diff(&self) -> bool {
        matches!(self, FileWindowKind::Diff | FileWindowKind::CommitDiff)
    }
}

/// Which of its two views a markdown File window shows. Other kinds ignore it.
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
pub struct FileWindowRow {
    pub workspace_id: String,
    pub kind: FileWindowKind,
    /// Absolute for text and image windows; Workspace-relative for diffs,
    /// which is how git and diff panes spell a path.
    pub file_path: String,
    /// `None` for every kind but `CommitDiff`.
    pub commit_oid: Option<String>,
    /// The git section a live diff was last opened from.
    pub diff_section: Option<String>,
    pub label: String,
    pub view: MarkdownView,
}

/// What `file_window_open` is asked to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileWindowTarget {
    pub kind: FileWindowKind,
    pub file_path: String,
    pub commit_oid: Option<String>,
    pub diff_section: Option<String>,
}

pub fn new_label() -> String {
    format!("{}{}", FILE_WINDOW_PREFIX, Uuid::new_v4())
}

pub fn is_file_window_label(label: &str) -> bool {
    label.starts_with(FILE_WINDOW_PREFIX)
}

/// What a File window needs to know about its Workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceMeta {
    pub name: String,
    pub root_folder: String,
    pub profile_id: String,
    pub base_branch: Option<String>,
}

/// Sent to a File window that should save its buffer. It answers by
/// reporting itself clean through `file_window_set_dirty`.
pub const FILE_WINDOW_SAVE: &str = "file-window-save";

/// The git sections a live diff can be read from. `conflicted` is not one:
/// a conflicted file has no diff, only the file itself.
const DIFF_SECTIONS: &[&str] = &["against_base", "staged", "unstaged", "untracked"];

/// The kind a file on disk gets, by the same extension rules `fs_read_file`
/// uses: an image, or text unless the extension is a known binary one.
/// `None` means a File pane could not show it, so it has no File window. A
/// file whose *bytes* turn out to be binary is only found when it is read; the
/// window then says so, as a File pane does.
pub fn kind_for_path(path: &Path) -> Option<FileWindowKind> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if crate::file_explorer::is_image_ext(&ext) {
        Some(FileWindowKind::Image)
    } else if crate::file_explorer::is_binary_ext(&ext) {
        None
    } else {
        Some(FileWindowKind::Text)
    }
}

/// A Workspace-relative path, spelled with `/`, for the two diff kinds. Refuses
/// anything that could leave the folder: an absolute path, a drive prefix or a
/// `..`. Git reports paths this way, so a diff of a deleted file is still valid
/// even though nothing is on disk.
pub fn relative_key(file_path: &str) -> Result<String, AbundioError> {
    let refuse = || AbundioError::InvalidOperation("Not a path inside the Workspace".into());
    let mut parts = Vec::new();
    for c in Path::new(&file_path.replace('\\', "/")).components() {
        match c {
            Component::Normal(p) => parts.push(p.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => return Err(refuse()),
        }
    }
    if parts.is_empty() {
        return Err(refuse());
    }
    Ok(parts.join("/"))
}

fn valid_oid(oid: &str) -> bool {
    (7..=64).contains(&oid.len()) && oid.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Checks a target and returns its canonical key. Checked in Rust, not only in
/// the UI, because the IPC is downstream of every entry point.
///
/// - Text and image: an existing file inside the Workspace folder, of that
///   kind. Both sides are canonicalised, so `..` and symlinks cannot walk out.
/// - Diffs: a Workspace-relative path (see `relative_key`); a commit diff also
///   needs a commit id, and a live diff a known section.
pub fn validate_target(root_folder: &str, target: &FileWindowTarget) -> Result<String, AbundioError> {
    match target.kind {
        FileWindowKind::Text | FileWindowKind::Image => {
            let root = Path::new(root_folder).canonicalize()?;
            let path = Path::new(&target.file_path).canonicalize()?;
            if !path.starts_with(&root) {
                return Err(AbundioError::InvalidOperation(
                    "File is outside the Workspace folder".into(),
                ));
            }
            if !path.is_file() || kind_for_path(&path) != Some(target.kind) {
                return Err(AbundioError::InvalidOperation(
                    "This file cannot open in a separate window".into(),
                ));
            }
            Ok(path.to_string_lossy().into_owned())
        }
        FileWindowKind::Diff => {
            let section = target.diff_section.as_deref().unwrap_or("");
            if !DIFF_SECTIONS.contains(&section) {
                return Err(AbundioError::InvalidOperation("Unknown diff section".into()));
            }
            relative_key(&target.file_path)
        }
        FileWindowKind::CommitDiff => {
            if !target.commit_oid.as_deref().is_some_and(valid_oid) {
                return Err(AbundioError::InvalidOperation("Not a commit id".into()));
            }
            relative_key(&target.file_path)
        }
        FileWindowKind::Unknown => Err(AbundioError::InvalidOperation(
            "Unknown kind of window".into(),
        )),
    }
}

/// What restoring should do with a remembered row.
#[derive(Debug, PartialEq, Eq)]
pub enum RestoreCheck {
    /// Reopen it. Carries the canonical key.
    Reopen(String),
    /// The file is gone, or is no longer that kind of file inside the folder:
    /// forget the window, quietly.
    Forget,
    /// The Workspace folder cannot be reached, or the file cannot be read for
    /// some other reason (an unmounted drive, permissions). Keep the row and
    /// try again next time: the user never closed this window.
    Keep,
}

/// Decides a remembered row's fate. Only a file that is *known* to be gone
/// forgets the window; any doubt keeps it. A diff window does not need its
/// file on disk (a deleted file still has a diff, and a commit's never
/// changes), only a reachable folder.
pub fn check_restore(root_folder: &str, row: &FileWindowRow) -> RestoreCheck {
    if row.kind == FileWindowKind::Unknown {
        return RestoreCheck::Keep;
    }
    let Ok(root) = Path::new(root_folder).canonicalize() else {
        return RestoreCheck::Keep;
    };
    if row.kind.is_diff() {
        return match relative_key(&row.file_path) {
            Ok(key) => RestoreCheck::Reopen(key),
            Err(_) => RestoreCheck::Forget,
        };
    }
    match Path::new(&row.file_path).canonicalize() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => RestoreCheck::Forget,
        Err(_) => RestoreCheck::Keep,
        Ok(path)
            if path.starts_with(&root) && path.is_file() && kind_for_path(&path) == Some(row.kind) =>
        {
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

/// The OS window title. The file part matches what a pane of the same thing
/// is called (`app.ts (diff)`, `app.ts @ a1b2c3d`), so a file's text window and
/// its diff window can be told apart in the Window menu.
pub fn window_title(row: &FileWindowRow, workspace_name: &str) -> String {
    let file_name = Path::new(&row.file_path.replace('\\', "/"))
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&row.file_path)
        .to_string();
    let shown = match row.kind {
        FileWindowKind::Text | FileWindowKind::Image | FileWindowKind::Unknown => file_name,
        FileWindowKind::Diff => format!("{file_name} (diff)"),
        FileWindowKind::CommitDiff => {
            let oid = row.commit_oid.as_deref().unwrap_or("");
            format!("{file_name} @ {}", &oid[..oid.len().min(7)])
        }
    };
    format!("{shown} — {workspace_name}")
}

// ── Store ──

const ROW_COLUMNS: &str = "workspace_id, kind, file_path, commit_oid, diff_section, label, view";

pub struct FileWindowStore {
    conn: Mutex<Connection>,
    /// Labels of open File windows with unsaved edits. Each window reports
    /// its own state; the owning Window cannot see into another webview, so it
    /// asks here before closing a Workspace (ADR-0046). In memory only: an
    /// unsaved buffer does not survive the window anyway.
    dirty: Mutex<HashSet<String>>,
}

impl FileWindowStore {
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
            "SELECT name, root_folder, profile_id, base_branch FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |r| {
                Ok(WorkspaceMeta {
                    name: r.get(0)?,
                    root_folder: r.get(1)?,
                    profile_id: r.get(2)?,
                    base_branch: r.get(3)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    /// Labels of every File window whose Workspace is in this Profile.
    pub fn labels_for_profile(&self, profile_id: &str) -> Result<Vec<String>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT m.label FROM file_windows m
             JOIN workspaces w ON w.id = m.workspace_id
             WHERE w.profile_id = ?1",
        )?;
        let rows = stmt.query_map(params![profile_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// The row for this target, created if missing. One window per file and
    /// kind (and commit): a second open of the same thing finds the first row
    /// and so the same label.
    ///
    /// Keyed by `canonical_path`, so every spelling of one file (separators,
    /// symlinked folders, case on a case-insensitive disk) finds the same row.
    /// `file_path` is kept as the first opener spelled it. A live diff's
    /// section follows the latest open, as a diff pane's does.
    pub fn upsert(
        &self,
        workspace_id: &str,
        target: &FileWindowTarget,
        canonical_path: &str,
    ) -> Result<FileWindowRow, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let oid = target.commit_oid.as_deref().unwrap_or("");
        // `INSERT OR IGNORE` then read back, under one lock, so two opens of the
        // same thing can never mint two labels.
        conn.execute(
            "INSERT OR IGNORE INTO file_windows
               (workspace_id, kind, file_path, canonical_path, commit_oid, diff_section, label)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                workspace_id,
                target.kind.as_str(),
                target.file_path,
                canonical_path,
                oid,
                target.diff_section,
                new_label()
            ],
        )?;
        if target.kind == FileWindowKind::Diff {
            conn.execute(
                "UPDATE file_windows SET diff_section = ?1
                 WHERE workspace_id = ?2 AND kind = 'diff' AND canonical_path = ?3",
                params![target.diff_section, workspace_id, canonical_path],
            )?;
        }
        let row = conn.query_row(
            &format!(
                "SELECT {ROW_COLUMNS} FROM file_windows
                 WHERE workspace_id = ?1 AND kind = ?2 AND canonical_path = ?3 AND commit_oid = ?4"
            ),
            params![workspace_id, target.kind.as_str(), canonical_path, oid],
            read_row,
        )?;
        Ok(row)
    }

    /// Records a row's canonical path. `false` when another row of the same
    /// Workspace and kind already has it: this row is a duplicate spelling.
    pub fn set_canonical(&self, label: &str, canonical_path: &str) -> Result<bool, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "UPDATE OR IGNORE file_windows SET canonical_path = ?1 WHERE label = ?2",
            params![canonical_path, label],
        )?;
        Ok(changed > 0)
    }

    pub fn find_by_label(&self, label: &str) -> Result<Option<FileWindowRow>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {ROW_COLUMNS} FROM file_windows WHERE label = ?1"),
            params![label],
            read_row,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn list_for_workspace(&self, workspace_id: &str) -> Result<Vec<FileWindowRow>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {ROW_COLUMNS} FROM file_windows
             WHERE workspace_id = ?1
             ORDER BY created_at ASC, file_path ASC"
        ))?;
        let rows = stmt.query_map(params![workspace_id], read_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Every row, across Workspaces.
    pub fn list_all(&self) -> Result<Vec<FileWindowRow>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {ROW_COLUMNS} FROM file_windows ORDER BY created_at ASC, file_path ASC"
        ))?;
        let rows = stmt.query_map([], read_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// The window's remembered **Window placement** (ADR-0051). `None` when it
    /// was never placed, or the stored value no longer parses.
    pub fn placement(&self, label: &str) -> Result<Option<Remembered>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let json: Option<Option<String>> = conn
            .query_row(
                "SELECT placement FROM file_windows WHERE label = ?1",
                params![label],
                |r| r.get(0),
            )
            .optional()?;
        Ok(json.flatten().and_then(|j| serde_json::from_str(&j).ok()))
    }

    /// Stores the window's placement. A forgotten row (already deleted by its
    /// own close handler) is left forgotten.
    pub fn set_placement(&self, label: &str, placement: &Remembered) -> Result<(), AbundioError> {
        let json = serde_json::to_string(placement)
            .map_err(|e| AbundioError::InvalidOperation(format!("placement: {e}")))?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE file_windows SET placement = ?1 WHERE label = ?2",
            params![json, label],
        )?;
        Ok(())
    }

    pub fn set_view(&self, label: &str, view: MarkdownView) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE file_windows SET view = ?1 WHERE label = ?2",
            params![view.as_str(), label],
        )?;
        Ok(())
    }

    /// Forgets a window. A missing row is not an error: forgetting twice is
    /// what a close racing a Workspace delete looks like.
    pub fn delete_by_label(&self, label: &str) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM file_windows WHERE label = ?1", params![label])?;
        Ok(())
    }
}

// ── Windows ──

/// Focuses the row's window if it is open, or builds it where it was last
/// (its **Window placement**).
pub fn open_or_focus(
    app: &AppHandle<Wry>,
    row: &FileWindowRow,
    meta: &WorkspaceMeta,
) -> Result<(), AbundioError> {
    if let Some(existing) = app.get_webview_window(&row.label) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        // A live diff reopened from another section shows that section now.
        if row.kind == FileWindowKind::Diff {
            let _ = app.emit_to(row.label.as_str(), FILE_WINDOW_RELOAD, ());
        }
        return Ok(());
    }
    build_window(app, row, meta, true, false)
}

/// Sent to an open File window whose row changed under it (a live diff opened
/// again from another section). It re-reads `file_window_info`.
pub const FILE_WINDOW_RELOAD: &str = "file-window-reload";

/// Builds the row's window. `focus: false` opens it behind the current one.
/// `restore_desktop` puts it back on its remembered desktop (app start only).
fn build_window(
    app: &AppHandle<Wry>,
    row: &FileWindowRow,
    meta: &WorkspaceMeta,
    focus: bool,
    restore_desktop: bool,
) -> Result<(), AbundioError> {
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = WebviewWindowBuilder::new(
        app,
        &row.label,
        WebviewUrl::App("index.html?file-window".into()),
    )
    .title(window_title(row, &meta.name))
    .inner_size(880.0, 760.0)
    .min_inner_size(420.0, 320.0)
    .resizable(true)
    .focused(focus)
    // Hidden until placed, so it never shows at the default spot first.
    .visible(false);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    let window = builder.build().map_err(|e| {
        AbundioError::InvalidOperation(format!("File window build failed: {e}"))
    })?;
    let placement = app
        .try_state::<FileWindowStore>()
        .and_then(|s| s.placement(&row.label).ok().flatten());
    crate::window_frame::place_and_show(&window, placement, focus, restore_desktop);
    Ok(())
}

/// Closes these windows on their owner's behalf, so their rows are kept and
/// they reopen with the Workspace. `destroy`, not `close`: the owner has
/// already asked about unsaved edits, and `destroy` skips the window's own
/// close handler — which is the one place a row is forgotten.
pub fn destroy_remembered(app: &AppHandle<Wry>, labels: &[String]) {
    // Record where they are first: once destroyed they cannot be asked.
    crate::window_frame::record_all(app);
    for label in labels {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
}

/// Cleans up after a File window's `Destroyed`. Its row is untouched.
pub fn on_destroyed(app: &AppHandle<Wry>, label: &str) {
    let placement = app
        .try_state::<PlacementTracker>()
        .and_then(|t| {
            let p = t.get(label);
            t.forget(label);
            p
        });
    if let Some(store) = app.try_state::<FileWindowStore>() {
        store.set_dirty(label, false);
        if let Some(p) = placement {
            if let Err(e) = store.set_placement(label, &p) {
                eprintln!("[abundio] failed to save File window placement: {e}");
            }
        }
    }
}

/// Closes, and remembers, the File windows of a Profile. Called when the
/// Profile's Window is destroyed, because React cleanup never runs then.
pub fn destroy_for_profile(app: &AppHandle<Wry>, profile_id: &str) {
    let Some(store) = app.try_state::<FileWindowStore>() else {
        return;
    };
    match store.labels_for_profile(profile_id) {
        Ok(labels) => destroy_remembered(app, &labels),
        Err(e) => eprintln!("[abundio] file windows for profile: {e}"),
    }
}

fn labels_for_workspaces(
    store: &FileWindowStore,
    workspace_ids: &[String],
) -> Result<Vec<String>, AbundioError> {
    let mut labels = Vec::new();
    for id in workspace_ids {
        labels.extend(store.list_for_workspace(id)?.into_iter().map(|r| r.label));
    }
    Ok(labels)
}

fn row_for_caller(store: &FileWindowStore, window: &WebviewWindow) -> Result<FileWindowRow, AbundioError> {
    store
        .find_by_label(window.label())?
        .ok_or_else(|| AbundioError::NotFound(format!("file window {}", window.label())))
}

// ── IPC ──

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWindowInfo {
    pub workspace_id: String,
    pub workspace_name: String,
    pub root_folder: String,
    pub base_branch: Option<String>,
    pub kind: FileWindowKind,
    pub file_path: String,
    pub commit_oid: Option<String>,
    pub diff_section: Option<String>,
    pub view: MarkdownView,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyFileWindow {
    pub label: String,
    pub file_path: String,
}

/// What `file_window_open` was asked for, in canonical form: only the field
/// its kind uses is kept, and a commit id is lowercased so `A1B2…` and
/// `a1b2…` are one window (git always reports lowercase oids).
pub fn target_from_ipc(
    kind: FileWindowKind,
    file_path: String,
    commit_oid: Option<String>,
    diff_section: Option<String>,
) -> FileWindowTarget {
    FileWindowTarget {
        kind,
        file_path,
        commit_oid: if kind == FileWindowKind::CommitDiff {
            commit_oid.map(|o| o.to_ascii_lowercase())
        } else {
            None
        },
        diff_section: if kind == FileWindowKind::Diff { diff_section } else { None },
    }
}

/// Opens a file of a Workspace in its File window, or focuses the one already
/// showing it.
#[tauri::command]
pub async fn file_window_open(
    app: AppHandle,
    store: State<'_, FileWindowStore>,
    workspace_id: String,
    kind: FileWindowKind,
    file_path: String,
    commit_oid: Option<String>,
    diff_section: Option<String>,
) -> Result<(), AbundioError> {
    let meta = store
        .workspace_meta(&workspace_id)?
        .ok_or_else(|| AbundioError::NotFound(format!("workspace {workspace_id}")))?;
    let mut target = target_from_ipc(kind, file_path, commit_oid, diff_section);
    let canonical = validate_target(&meta.root_folder, &target)?;
    // Keyed by the canonical path, so a link and the explorer, which spell
    // one file differently, share one window. A text or image window keeps
    // the caller's spelling in native separators, which is what the
    // explorer, File panes and the file watcher use; a diff keeps git's.
    target.file_path = if kind.is_diff() {
        canonical.clone()
    } else {
        native_spelling(&target.file_path)
    };
    let row = store.upsert(&workspace_id, &target, &canonical)?;
    open_or_focus(&app, &row, &meta)
}

/// The calling File window's target and Workspace. Read by label, never from
/// the URL, so a window cannot be pointed at a file by its own query string.
#[tauri::command]
pub async fn file_window_info(
    window: WebviewWindow,
    store: State<'_, FileWindowStore>,
) -> Result<FileWindowInfo, AbundioError> {
    let row = row_for_caller(&store, &window)?;
    let meta = store
        .workspace_meta(&row.workspace_id)?
        .ok_or_else(|| AbundioError::NotFound(format!("workspace {}", row.workspace_id)))?;
    Ok(FileWindowInfo {
        workspace_id: row.workspace_id,
        workspace_name: meta.name,
        root_folder: meta.root_folder,
        base_branch: meta.base_branch,
        kind: row.kind,
        file_path: row.file_path,
        commit_oid: row.commit_oid,
        diff_section: row.diff_section,
        view: row.view,
    })
}

#[tauri::command]
pub async fn file_window_set_view(
    window: WebviewWindow,
    store: State<'_, FileWindowStore>,
    view: MarkdownView,
) -> Result<(), AbundioError> {
    store.set_view(window.label(), view)
}

#[tauri::command]
pub async fn file_window_set_dirty(
    window: WebviewWindow,
    store: State<'_, FileWindowStore>,
    dirty: bool,
) -> Result<(), AbundioError> {
    if is_file_window_label(window.label()) {
        store.set_dirty(window.label(), dirty);
    }
    Ok(())
}

/// Forgets the calling window: the user closed it themselves.
#[tauri::command]
pub async fn file_window_forget(
    window: WebviewWindow,
    store: State<'_, FileWindowStore>,
) -> Result<(), AbundioError> {
    store.delete_by_label(window.label())
}

/// The open File windows of these Workspaces that have unsaved edits.
#[tauri::command]
pub async fn file_windows_dirty(
    app: AppHandle,
    store: State<'_, FileWindowStore>,
    workspace_ids: Vec<String>,
) -> Result<Vec<DirtyFileWindow>, AbundioError> {
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
    rows: Vec<FileWindowRow>,
    is_dirty: impl Fn(&str) -> bool,
    is_open: impl Fn(&str) -> bool,
) -> Vec<DirtyFileWindow> {
    rows.into_iter()
        .filter(|r| is_dirty(&r.label) && is_open(&r.label))
        .map(|r| DirtyFileWindow {
            label: r.label,
            file_path: r.file_path,
        })
        .collect()
}

/// One open File window, as the **Navigator** lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFileWindow {
    pub label: String,
    pub workspace_id: String,
    pub kind: FileWindowKind,
    pub file_path: String,
    pub commit_oid: Option<String>,
}

/// The open File windows of these Workspaces. A row is remembered while its
/// window is closed with its Workspace, so only rows with a live window count.
#[tauri::command]
pub async fn file_windows_list(
    app: AppHandle,
    store: State<'_, FileWindowStore>,
    workspace_ids: Vec<String>,
) -> Result<Vec<OpenFileWindow>, AbundioError> {
    let mut rows = Vec::new();
    for id in &workspace_ids {
        rows.extend(store.list_for_workspace(id)?);
    }
    Ok(open_windows(rows, |l| app.get_webview_window(l).is_some()))
}

/// The rows whose window is open, in row order.
pub fn open_windows(rows: Vec<FileWindowRow>, is_open: impl Fn(&str) -> bool) -> Vec<OpenFileWindow> {
    rows.into_iter()
        .filter(|r| is_open(&r.label))
        .map(|r| OpenFileWindow {
            label: r.label,
            workspace_id: r.workspace_id,
            kind: r.kind,
            file_path: r.file_path,
            commit_oid: r.commit_oid,
        })
        .collect()
}

/// Brings one open File window to the front and focuses it: the user picked
/// it in the Navigator. Only File window labels are accepted.
#[tauri::command]
pub async fn file_window_focus(app: AppHandle, label: String) -> Result<(), AbundioError> {
    if !is_file_window_label(&label) {
        return Err(AbundioError::NotFound(format!("file window {label}")));
    }
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| AbundioError::NotFound(format!("file window {label}")))?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}

/// Asks these windows to save. Each answers by reporting itself clean.
#[tauri::command]
pub async fn file_windows_save(app: AppHandle, labels: Vec<String>) -> Result<(), AbundioError> {
    for label in labels.iter().filter(|l| is_file_window_label(l)) {
        let _ = app.emit_to(label.as_str(), FILE_WINDOW_SAVE, ());
    }
    Ok(())
}

/// Closes the File windows of these Workspaces and remembers them.
#[tauri::command]
pub async fn file_windows_close(
    app: AppHandle,
    store: State<'_, FileWindowStore>,
    workspace_ids: Vec<String>,
) -> Result<(), AbundioError> {
    let labels = labels_for_workspaces(&store, &workspace_ids)?;
    destroy_remembered(&app, &labels);
    Ok(())
}

/// Reopens a Workspace's remembered File windows. A row whose file is gone
/// (or no longer that kind of file inside the folder) is dropped quietly.
#[tauri::command]
pub async fn file_windows_restore(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, FileWindowStore>,
    workspace_id: String,
) -> Result<(), AbundioError> {
    // The first reopen from a Window restored at app start is part of app
    // start, so its File windows go back to their desktops (ADR-0051).
    let restore_desktop = app
        .try_state::<crate::window_frame::LaunchRestore>()
        .is_some_and(|l| l.take(window.label()));
    let Some(meta) = store.workspace_meta(&workspace_id)? else {
        return Ok(());
    };
    for row in store.list_for_workspace(&workspace_id)? {
        match check_restore(&meta.root_folder, &row) {
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
        if let Err(e) = open_unfocused(&app, &row, &meta, restore_desktop) {
            eprintln!("[abundio] reopen file window {}: {e}", row.label);
        }
    }
    Ok(())
}

/// **File window raise**: brings a Workspace's open File windows up above
/// other windows without focusing them (see GLOSSARY.md). Best effort: a
/// failure is logged, never shown to the user.
#[tauri::command]
pub async fn file_windows_raise(
    app: AppHandle,
    store: State<'_, FileWindowStore>,
    workspace_id: String,
) -> Result<(), AbundioError> {
    let windows: Vec<WebviewWindow> = store
        .list_for_workspace(&workspace_id)?
        .iter()
        .filter_map(|r| app.get_webview_window(&r.label))
        .collect();
    crate::window_raise::raise_without_focus(&app, windows);
    Ok(())
}

/// Restoring opens windows without stealing focus: the user is working in the
/// Profile window that just opened the Workspace.
fn open_unfocused(
    app: &AppHandle<Wry>,
    row: &FileWindowRow,
    meta: &WorkspaceMeta,
    restore_desktop: bool,
) -> Result<(), AbundioError> {
    if app.get_webview_window(&row.label).is_some() {
        return Ok(());
    }
    build_window(app, row, meta, false, restore_desktop)
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileWindowRow> {
    let oid: String = row.get(3)?;
    Ok(FileWindowRow {
        workspace_id: row.get(0)?,
        kind: FileWindowKind::from_str(&row.get::<_, String>(1)?),
        file_path: row.get(2)?,
        commit_oid: if oid.is_empty() { None } else { Some(oid) },
        diff_section: row.get(4)?,
        label: row.get(5)?,
        view: MarkdownView::from_str(&row.get::<_, String>(6)?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(workspaces: &[&str]) -> FileWindowStore {
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
        FileWindowStore::new(conn)
    }

    fn text(path: &str) -> FileWindowTarget {
        FileWindowTarget {
            kind: FileWindowKind::Text,
            file_path: path.into(),
            commit_oid: None,
            diff_section: None,
        }
    }

    fn diff(path: &str, section: &str) -> FileWindowTarget {
        FileWindowTarget {
            kind: FileWindowKind::Diff,
            file_path: path.into(),
            commit_oid: None,
            diff_section: Some(section.into()),
        }
    }

    fn commit(path: &str, oid: &str) -> FileWindowTarget {
        FileWindowTarget {
            kind: FileWindowKind::CommitDiff,
            file_path: path.into(),
            commit_oid: Some(oid.into()),
            diff_section: None,
        }
    }

    fn row_of(kind: FileWindowKind, path: &str) -> FileWindowRow {
        FileWindowRow {
            workspace_id: "w1".into(),
            kind,
            file_path: path.into(),
            commit_oid: None,
            diff_section: None,
            label: "md-x".into(),
            view: MarkdownView::Rendered,
        }
    }

    #[test]
    fn upsert_creates_a_rendered_text_row_with_an_md_label() {
        let s = store_with(&["w1"]);
        let row = s.upsert("w1", &text("/tmp/README.md"), "/tmp/README.md").unwrap();
        assert!(row.label.starts_with(FILE_WINDOW_PREFIX));
        assert_eq!(row.kind, FileWindowKind::Text);
        assert_eq!(row.view, MarkdownView::Rendered);
        assert_eq!(row.file_path, "/tmp/README.md");
        assert_eq!(row.commit_oid, None);
    }

    #[test]
    fn upsert_twice_returns_the_same_label() {
        let s = store_with(&["w1"]);
        let a = s.upsert("w1", &text("/tmp/a.md"), "/tmp/a.md").unwrap();
        let b = s.upsert("w1", &text("/tmp/a.md"), "/tmp/a.md").unwrap();
        assert_eq!(a.label, b.label);
        assert_eq!(s.list_for_workspace("w1").unwrap().len(), 1);
    }

    #[test]
    fn a_files_text_and_diff_windows_are_two_rows() {
        let s = store_with(&["w1"]);
        let t = s.upsert("w1", &text("/tmp/a.ts"), "a.ts").unwrap();
        let d = s.upsert("w1", &diff("a.ts", "unstaged"), "a.ts").unwrap();
        assert_ne!(t.label, d.label);
        assert_eq!(s.list_for_workspace("w1").unwrap().len(), 2);
    }

    #[test]
    fn one_file_at_two_commits_is_two_rows_and_the_same_commit_is_one() {
        let s = store_with(&["w1"]);
        let a = s.upsert("w1", &commit("a.ts", "aaaaaaa1"), "a.ts").unwrap();
        let b = s.upsert("w1", &commit("a.ts", "bbbbbbb2"), "a.ts").unwrap();
        let a2 = s.upsert("w1", &commit("a.ts", "aaaaaaa1"), "a.ts").unwrap();
        assert_ne!(a.label, b.label);
        assert_eq!(a.label, a2.label);
        assert_eq!(a.commit_oid.as_deref(), Some("aaaaaaa1"));
    }

    #[test]
    fn a_live_diff_is_one_window_whose_section_follows_the_latest_open() {
        let s = store_with(&["w1"]);
        let a = s.upsert("w1", &diff("a.ts", "unstaged"), "a.ts").unwrap();
        let b = s.upsert("w1", &diff("a.ts", "staged"), "a.ts").unwrap();
        assert_eq!(a.label, b.label);
        assert_eq!(b.diff_section.as_deref(), Some("staged"));
    }

    #[test]
    fn the_same_file_in_two_workspaces_is_two_windows() {
        let s = store_with(&["w1", "w2"]);
        let a = s.upsert("w1", &text("/tmp/a.md"), "/tmp/a.md").unwrap();
        let b = s.upsert("w2", &text("/tmp/a.md"), "/tmp/a.md").unwrap();
        assert_ne!(a.label, b.label);
    }

    #[test]
    fn placement_is_stored_per_row_and_a_forgotten_row_stays_forgotten() {
        let store = store_with(&["w1"]);
        let row = store.upsert("w1", &text("/r/a.md"), "/r/a.md").unwrap();
        assert_eq!(store.placement(&row.label).unwrap(), None);
        let p: Remembered = serde_json::from_str(
            r#"{"home":{"monitor":{"name":"DELL","arrangementIndex":1},"relX":5,"relY":6,"width":700,"height":500,"maximized":true}}"#,
        )
        .unwrap();
        store.set_placement(&row.label, &p).unwrap();
        assert_eq!(store.placement(&row.label).unwrap(), Some(p.clone()));
        store.delete_by_label(&row.label).unwrap();
        store.set_placement(&row.label, &p).unwrap();
        assert_eq!(store.placement(&row.label).unwrap(), None);
    }

    #[test]
    fn set_view_is_kept() {
        let s = store_with(&["w1"]);
        let row = s.upsert("w1", &text("/tmp/a.md"), "/tmp/a.md").unwrap();
        s.set_view(&row.label, MarkdownView::Source).unwrap();
        let again = s.upsert("w1", &text("/tmp/a.md"), "/tmp/a.md").unwrap();
        assert_eq!(again.view, MarkdownView::Source);
    }

    #[test]
    fn delete_by_label_forgets_and_is_idempotent() {
        let s = store_with(&["w1"]);
        let row = s.upsert("w1", &text("/tmp/a.md"), "/tmp/a.md").unwrap();
        s.delete_by_label(&row.label).unwrap();
        s.delete_by_label(&row.label).unwrap();
        assert!(s.find_by_label(&row.label).unwrap().is_none());
    }

    #[test]
    fn deleting_the_workspace_deletes_its_rows() {
        let s = store_with(&["w1", "w2"]);
        s.upsert("w1", &text("/tmp/a.md"), "/tmp/a.md").unwrap();
        s.upsert("w2", &text("/tmp/b.md"), "/tmp/b.md").unwrap();
        s.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM workspaces WHERE id = 'w1'", [])
            .unwrap();
        assert!(s.list_for_workspace("w1").unwrap().is_empty());
        assert_eq!(s.list_all().unwrap().len(), 1);
    }

    #[test]
    fn unknown_values_read_safely() {
        assert_eq!(MarkdownView::from_str("split"), MarkdownView::Rendered);
        assert_eq!(FileWindowKind::from_str("video"), FileWindowKind::Unknown);
        assert_eq!(FileWindowKind::from_str("text"), FileWindowKind::Text);
    }

    #[test]
    fn a_newer_builds_kind_is_kept_on_restore_and_never_opened() {
        // A Workspace-relative path, as a future kind might store: read as text
        // it would canonicalise against the process CWD and be forgotten.
        let dir = tempfile::tempdir().unwrap();
        let row = row_of(FileWindowKind::Unknown, "src/app.ts");
        assert_eq!(check_restore(dir.path().to_str().unwrap(), &row), RestoreCheck::Keep);
        let t = FileWindowTarget { kind: FileWindowKind::Unknown, ..text("src/app.ts") };
        assert!(validate_target(dir.path().to_str().unwrap(), &t).is_err());
        // And the IPC's deserializer maps an unknown kind there too.
        let k: FileWindowKind = serde_json::from_str("\"video\"").unwrap();
        assert_eq!(k, FileWindowKind::Unknown);
    }

    /// The frontend decides which files get the menu item from its own copy
    /// of the extension lists (`src/lib/fileWindowKind.ts`). If the copies
    /// drift, the menu offers a window Rust then refuses, and the click does
    /// nothing visible. Read that file and compare both ways.
    #[test]
    fn frontend_extension_lists_match_rust() {
        let ts = include_str!("../../src/lib/fileWindowKind.ts");
        let block = |start: &str, end: &str| -> String {
            let a = ts.find(start).unwrap_or_else(|| panic!("{start} not found")) + start.len();
            let b = a + ts[a..].find(end).unwrap();
            ts[a..b].to_string()
        };
        let words = |s: &str| -> std::collections::BTreeSet<String> {
            s.split(|c: char| !c.is_ascii_alphanumeric())
                .filter(|w| !w.is_empty())
                .map(str::to_string)
                .collect()
        };
        let ts_images = words(&block("const IMAGE_EXTENSIONS = new Set([", "]);"));
        let ts_binary = words(&block("const BINARY_EXTENSIONS = new Set(", ".split("));
        let rust_images: std::collections::BTreeSet<String> =
            crate::file_explorer::IMAGE_MIMES.iter().map(|(e, _)| e.to_string()).collect();
        let rust_binary: std::collections::BTreeSet<String> =
            crate::file_explorer::BINARY_EXTS.iter().map(|e| e.to_string()).collect();
        assert_eq!(ts_images, rust_images, "image extensions differ");
        assert_eq!(ts_binary, rust_binary, "binary extensions differ");
    }

    #[test]
    fn file_window_labels_are_recognised() {
        assert!(is_file_window_label(&new_label()));
        assert!(new_label().starts_with("md-"));
        assert!(!is_file_window_label("main"));
        assert!(!is_file_window_label("window-1"));
        assert!(!is_file_window_label("settings"));
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
        assert_eq!(meta.base_branch, None);
        let row = s.upsert("w1", &text("/tmp/a.md"), "/tmp/a.md").unwrap();
        assert_eq!(s.labels_for_profile(&meta.profile_id).unwrap(), vec![row.label]);
        assert!(s.labels_for_profile("nobody").unwrap().is_empty());
        assert!(s.workspace_meta("missing").unwrap().is_none());
    }

    #[test]
    fn kind_follows_the_extension() {
        assert_eq!(kind_for_path(Path::new("a.md")), Some(FileWindowKind::Text));
        assert_eq!(kind_for_path(Path::new("a.ts")), Some(FileWindowKind::Text));
        assert_eq!(kind_for_path(Path::new("Makefile")), Some(FileWindowKind::Text));
        assert_eq!(kind_for_path(Path::new("a.PNG")), Some(FileWindowKind::Image));
        assert_eq!(kind_for_path(Path::new("a.svg")), Some(FileWindowKind::Image));
        assert_eq!(kind_for_path(Path::new("a.zip")), None);
        assert_eq!(kind_for_path(Path::new("a.pdf")), None);
    }

    #[test]
    fn validate_accepts_text_and_images_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        for (name, kind) in [
            ("README.md", FileWindowKind::Text),
            ("main.rs", FileWindowKind::Text),
            ("logo.png", FileWindowKind::Image),
        ] {
            let file = dir.path().join(name);
            std::fs::write(&file, "x").unwrap();
            let t = FileWindowTarget { kind, ..text(file.to_str().unwrap()) };
            assert!(validate_target(root, &t).is_ok(), "{name}");
        }
    }

    #[test]
    fn validate_refuses_outside_missing_binary_and_the_wrong_kind() {
        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("ws");
        std::fs::create_dir(&inner).unwrap();
        std::fs::write(dir.path().join("secret.md"), "x").unwrap();
        let zip = inner.join("a.zip");
        std::fs::write(&zip, "x").unwrap();
        let png = inner.join("a.png");
        std::fs::write(&png, "x").unwrap();
        let root = inner.to_str().unwrap();
        // `..` resolves out of the folder.
        let escaped = inner.join("../secret.md");
        assert!(validate_target(root, &text(escaped.to_str().unwrap())).is_err());
        assert!(validate_target(root, &text(zip.to_str().unwrap())).is_err());
        assert!(validate_target(root, &text(png.to_str().unwrap())).is_err());
        let missing = inner.join("gone.md");
        assert!(validate_target(root, &text(missing.to_str().unwrap())).is_err());
        assert!(validate_target(root, &text(root)).is_err());
    }

    #[test]
    fn validate_diffs_needs_a_relative_path_and_its_section_or_commit() {
        let root = "/nowhere";
        assert_eq!(validate_target(root, &diff("src/a.ts", "staged")).unwrap(), "src/a.ts");
        assert_eq!(validate_target(root, &diff("src\\a.ts", "unstaged")).unwrap(), "src/a.ts");
        assert!(validate_target(root, &diff("src/a.ts", "conflicted")).is_err());
        assert!(validate_target(root, &diff("../a.ts", "staged")).is_err());
        assert!(validate_target(root, &diff("/etc/passwd", "staged")).is_err());
        assert!(validate_target(root, &diff("", "staged")).is_err());
        assert!(validate_target(root, &commit("a.ts", "0123abcd")).is_ok());
        assert!(validate_target(root, &commit("a.ts", "xyz")).is_err());
        assert!(validate_target(root, &commit("a.ts", "")).is_err());
    }

    #[test]
    fn ipc_targets_lowercase_the_commit_and_drop_fields_their_kind_ignores() {
        let t = target_from_ipc(
            FileWindowKind::CommitDiff,
            "a.ts".into(),
            Some("A1B2C3D4".into()),
            Some("staged".into()),
        );
        assert_eq!(t.commit_oid.as_deref(), Some("a1b2c3d4"));
        assert_eq!(t.diff_section, None);
        let d = target_from_ipc(FileWindowKind::Diff, "a.ts".into(), Some("abc1234".into()), Some("staged".into()));
        assert_eq!(d.commit_oid, None);
        assert_eq!(d.diff_section.as_deref(), Some("staged"));
        // So two spellings of one commit share a row.
        let s = store_with(&["w1"]);
        let up = target_from_ipc(FileWindowKind::CommitDiff, "a.ts".into(), Some("A1B2C3D4".into()), None);
        let low = target_from_ipc(FileWindowKind::CommitDiff, "a.ts".into(), Some("a1b2c3d4".into()), None);
        assert_eq!(
            s.upsert("w1", &up, "a.ts").unwrap().label,
            s.upsert("w1", &low, "a.ts").unwrap().label
        );
    }

    #[test]
    fn titles_name_the_kind() {
        let mut row = row_of(FileWindowKind::Text, "/repo/docs/README.md");
        assert_eq!(window_title(&row, "Repo"), "README.md — Repo");
        row = row_of(FileWindowKind::Diff, "src/app.ts");
        assert_eq!(window_title(&row, "Repo"), "app.ts (diff) — Repo");
        row = row_of(FileWindowKind::CommitDiff, "src/app.ts");
        row.commit_oid = Some("a1b2c3d4e5".into());
        assert_eq!(window_title(&row, "Repo"), "app.ts @ a1b2c3d — Repo");
    }

    #[test]
    fn two_spellings_of_one_file_share_a_row() {
        let s = store_with(&["w1"]);
        let a = s.upsert("w1", &text("C:\\repo\\a.md"), "/canon/a.md").unwrap();
        let b = s.upsert("w1", &text("C:/repo/a.md"), "/canon/a.md").unwrap();
        assert_eq!(a.label, b.label);
        // The first opener's spelling is kept.
        assert_eq!(b.file_path, "C:\\repo\\a.md");
    }

    #[test]
    fn set_canonical_refuses_a_duplicate() {
        let s = store_with(&["w1"]);
        let a = s.upsert("w1", &text("/tmp/a.md"), "/canon/a.md").unwrap();
        let b = s.upsert("w1", &text("/tmp/link/a.md"), "/tmp/link/a.md").unwrap();
        assert!(s.set_canonical(&a.label, "/canon/a.md").unwrap());
        assert!(!s.set_canonical(&b.label, "/canon/a.md").unwrap());
    }

    #[test]
    fn restore_reopens_a_file_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("main.rs");
        std::fs::write(&file, "fn main() {}").unwrap();
        let check = check_restore(
            dir.path().to_str().unwrap(),
            &row_of(FileWindowKind::Text, file.to_str().unwrap()),
        );
        let canonical = file.canonicalize().unwrap();
        assert_eq!(check, RestoreCheck::Reopen(canonical.to_string_lossy().into_owned()));
    }

    #[test]
    fn restore_forgets_a_deleted_file() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("gone.md");
        assert_eq!(
            check_restore(
                dir.path().to_str().unwrap(),
                &row_of(FileWindowKind::Text, gone.to_str().unwrap())
            ),
            RestoreCheck::Forget
        );
    }

    #[test]
    fn restore_reopens_a_diff_of_a_deleted_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert_eq!(
            check_restore(root, &row_of(FileWindowKind::Diff, "gone.ts")),
            RestoreCheck::Reopen("gone.ts".into())
        );
        assert_eq!(
            check_restore(root, &row_of(FileWindowKind::CommitDiff, "../x.ts")),
            RestoreCheck::Forget
        );
    }

    #[test]
    fn restore_keeps_the_row_when_the_folder_is_unreachable() {
        // An unmounted drive or network share: the root itself is missing.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("unmounted");
        let file = root.join("README.md");
        for row in [
            row_of(FileWindowKind::Text, file.to_str().unwrap()),
            row_of(FileWindowKind::Diff, "README.md"),
        ] {
            assert_eq!(check_restore(root.to_str().unwrap(), &row), RestoreCheck::Keep);
        }
    }

    #[test]
    fn restore_forgets_a_file_that_changed_kind_or_is_outside() {
        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("ws");
        std::fs::create_dir(&inner).unwrap();
        std::fs::write(dir.path().join("x.md"), "x").unwrap();
        let folder = inner.join("notes.md");
        std::fs::create_dir(&folder).unwrap();
        let png = inner.join("a.png");
        std::fs::write(&png, "x").unwrap();
        let root = inner.to_str().unwrap();
        let outside = inner.join("../x.md");
        assert_eq!(
            check_restore(root, &row_of(FileWindowKind::Text, outside.to_str().unwrap())),
            RestoreCheck::Forget
        );
        assert_eq!(
            check_restore(root, &row_of(FileWindowKind::Text, folder.to_str().unwrap())),
            RestoreCheck::Forget
        );
        assert_eq!(
            check_restore(root, &row_of(FileWindowKind::Text, png.to_str().unwrap())),
            RestoreCheck::Forget
        );
    }

    #[test]
    fn native_spelling_drops_doubled_separators() {
        assert_eq!(native_spelling("/repo//docs/./a.md"), "/repo/docs/a.md");
    }

    #[test]
    fn dirty_windows_needs_both_dirty_and_open() {
        let row = |label: &str| FileWindowRow {
            label: label.into(),
            ..row_of(FileWindowKind::Text, &format!("/r/{label}.md"))
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

    #[test]
    fn open_windows_keeps_only_live_windows() {
        let row = |label: &str| FileWindowRow {
            label: label.into(),
            ..row_of(FileWindowKind::Text, &format!("/r/{label}.md"))
        };
        let out = open_windows(vec![row("md-a"), row("md-b"), row("md-c")], |l| l != "md-b");
        let labels: Vec<_> = out.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["md-a", "md-c"]);
        assert_eq!(out[1].file_path, "/r/md-c.md");
    }

    #[test]
    fn migration_018_keeps_old_markdown_rows_and_labels() {
        let conn = Connection::open_in_memory().unwrap();
        // Run everything up to 017, write an old row, then run 018.
        conn.execute_batch(
            "CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))",
        )
        .unwrap();
        for (name, sql) in crate::migrations::MIGRATIONS {
            if *name == "018_file_windows" {
                break;
            }
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name) VALUES (?1)", [name]).unwrap();
        }
        conn.execute(
            "INSERT INTO workspaces (id, name, root_folder) VALUES ('w1', 'W', '/tmp')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO markdown_windows (workspace_id, file_path, canonical_path, label, view)
             VALUES ('w1', '/tmp/a.md', '/tmp/a.md', 'md-old', 'source')",
            [],
        )
        .unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        let s = FileWindowStore::new(conn);
        let row = s.find_by_label("md-old").unwrap().unwrap();
        assert_eq!(row.kind, FileWindowKind::Text);
        assert_eq!(row.view, MarkdownView::Source);
        assert_eq!(row.file_path, "/tmp/a.md");
        // And it is found again by an ordinary open.
        let again = s.upsert("w1", &text("/tmp/a.md"), "/tmp/a.md").unwrap();
        assert_eq!(again.label, "md-old");
    }
}
