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

use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
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

// ── Store ──

pub struct MarkdownWindowStore {
    conn: Mutex<Connection>,
}

impl MarkdownWindowStore {
    pub fn new(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }

    /// The row for this file, created if missing. One window per file: a
    /// second open of the same file finds the first row and so the same label.
    pub fn upsert(
        &self,
        workspace_id: &str,
        file_path: &str,
    ) -> Result<MarkdownWindowRow, AbundioError> {
        let conn = self.conn.lock().unwrap();
        // `INSERT OR IGNORE` then read back, under one lock, so two opens of the
        // same file can never mint two labels.
        conn.execute(
            "INSERT OR IGNORE INTO markdown_windows (workspace_id, file_path, label)
             VALUES (?1, ?2, ?3)",
            params![workspace_id, file_path, new_label()],
        )?;
        let row = conn.query_row(
            "SELECT workspace_id, file_path, label, view FROM markdown_windows
             WHERE workspace_id = ?1 AND file_path = ?2",
            params![workspace_id, file_path],
            read_row,
        )?;
        Ok(row)
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
        let row = s.upsert("w1", "/tmp/README.md").unwrap();
        assert!(row.label.starts_with(MARKDOWN_WINDOW_PREFIX));
        assert_eq!(row.view, MarkdownView::Rendered);
        assert_eq!(row.file_path, "/tmp/README.md");
    }

    #[test]
    fn upsert_twice_returns_the_same_label() {
        let s = store_with(&["w1"]);
        let a = s.upsert("w1", "/tmp/a.md").unwrap();
        let b = s.upsert("w1", "/tmp/a.md").unwrap();
        assert_eq!(a.label, b.label);
        assert_eq!(s.list_for_workspace("w1").unwrap().len(), 1);
    }

    #[test]
    fn the_same_file_in_two_workspaces_is_two_windows() {
        let s = store_with(&["w1", "w2"]);
        let a = s.upsert("w1", "/tmp/a.md").unwrap();
        let b = s.upsert("w2", "/tmp/a.md").unwrap();
        assert_ne!(a.label, b.label);
    }

    #[test]
    fn set_view_is_kept() {
        let s = store_with(&["w1"]);
        let row = s.upsert("w1", "/tmp/a.md").unwrap();
        s.set_view(&row.label, MarkdownView::Source).unwrap();
        let again = s.upsert("w1", "/tmp/a.md").unwrap();
        assert_eq!(again.view, MarkdownView::Source);
        assert_eq!(
            s.find_by_label(&row.label).unwrap().unwrap().view,
            MarkdownView::Source
        );
    }

    #[test]
    fn delete_by_label_forgets_and_is_idempotent() {
        let s = store_with(&["w1"]);
        let row = s.upsert("w1", "/tmp/a.md").unwrap();
        s.delete_by_label(&row.label).unwrap();
        s.delete_by_label(&row.label).unwrap();
        assert!(s.find_by_label(&row.label).unwrap().is_none());
    }

    #[test]
    fn deleting_the_workspace_deletes_its_rows() {
        let s = store_with(&["w1", "w2"]);
        s.upsert("w1", "/tmp/a.md").unwrap();
        s.upsert("w2", "/tmp/b.md").unwrap();
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
}
