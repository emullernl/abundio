//! Unsaved edits across every Window, for the quit confirmation.
//!
//! Each Profile window mirrors the file names of its unsaved **File panes**
//! here; Markdown windows already report theirs to `MarkdownWindowStore`.
//! Quit is decided in Rust (the frontend never sees the `quit-app` route), so
//! this is the only place a cross-window list exists — the same reason
//! `BusyCountsState` mirrors busy work (ADR-0034).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State, Window, Wry};

use crate::error::AbundioError;
use crate::markdown_windows::{self, MarkdownWindowStore, MARKDOWN_WINDOW_SAVE};
use crate::window_management::is_profile_window_label;

/// Sent to every Profile window by **Save and Quit**: save every unsaved File
/// pane. Each answers by mirroring an empty list.
pub const SAVE_ALL_BEFORE_QUIT: &str = "save-all-before-quit";

/// How long **Save and Quit** waits for every save to land before giving up
/// and staying open.
const SAVE_TIMEOUT: Duration = Duration::from_secs(8);
const SAVE_POLL: Duration = Duration::from_millis(100);

/// The quit dialog's buttons when something is unsaved.
pub const SAVE_AND_QUIT: &str = "Save and Quit";
pub const QUIT_WITHOUT_SAVING: &str = "Quit Without Saving";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitChoice {
    Save,
    Discard,
    Cancel,
}

/// Reads the quit dialog's answer. Depending on the platform, rfd hands back
/// either `Yes`/`No` or the custom button label; anything else (Escape, the
/// window's close button) is Cancel, the safe direction.
pub fn quit_choice(result: &tauri_plugin_dialog::MessageDialogResult) -> QuitChoice {
    use tauri_plugin_dialog::MessageDialogResult as R;
    match result {
        R::Yes => QuitChoice::Save,
        R::Custom(s) if s == SAVE_AND_QUIT => QuitChoice::Save,
        R::No => QuitChoice::Discard,
        R::Custom(s) if s == QUIT_WITHOUT_SAVING => QuitChoice::Discard,
        _ => QuitChoice::Cancel,
    }
}

/// Window label → paths of that Window's unsaved File panes.
#[derive(Default)]
pub struct UnsavedFilesState(pub Mutex<HashMap<String, Vec<String>>>);

impl UnsavedFilesState {
    pub fn set_for_window(&self, label: &str, paths: Vec<String>) {
        let mut map = self.0.lock().unwrap();
        if paths.is_empty() {
            map.remove(label);
        } else {
            map.insert(label.to_string(), paths);
        }
    }

    pub fn remove_for_window(&self, label: &str) {
        self.0.lock().unwrap().remove(label);
    }

    fn all(&self) -> Vec<String> {
        let map = self.0.lock().unwrap();
        let mut labels: Vec<&String> = map.keys().collect();
        labels.sort();
        labels.into_iter().flat_map(|l| map[l].clone()).collect()
    }
}

/// Paths of every unsaved buffer in the app: File panes in Profile windows,
/// then open Markdown windows.
pub fn unsaved_paths(app: &AppHandle<Wry>) -> Vec<String> {
    let mut out = app
        .try_state::<UnsavedFilesState>()
        .map(|s| s.all())
        .unwrap_or_default();
    if let Some(store) = app.try_state::<MarkdownWindowStore>() {
        for label in dirty_markdown_labels(app, &store) {
            if let Ok(Some(row)) = store.find_by_label(&label) {
                out.push(row.file_path);
            }
        }
    }
    out
}

fn dirty_markdown_labels(app: &AppHandle<Wry>, store: &MarkdownWindowStore) -> Vec<String> {
    app.webview_windows()
        .keys()
        .filter(|l| markdown_windows::is_markdown_window_label(l) && store.is_dirty(l))
        .cloned()
        .collect()
}

/// The quit dialog's message when something is unsaved. `busy` is the
/// busy-work sentence, when there is also running work to warn about.
pub fn unsaved_quit_message(paths: &[String], busy: Option<&str>) -> String {
    let names: Vec<&str> = paths
        .iter()
        .map(|p| Path::new(p).file_name().and_then(|n| n.to_str()).unwrap_or(p))
        .collect();
    let files = match names.as_slice() {
        [] => String::new(),
        [one] => format!("“{one}” has unsaved changes."),
        [a, b] => format!("“{a}” and “{b}” have unsaved changes."),
        [a, b, c] => format!("“{a}”, “{b}” and “{c}” have unsaved changes."),
        [a, b, rest @ ..] => format!(
            "“{a}”, “{b}” and {} other files have unsaved changes.",
            rest.len()
        ),
    };
    match busy {
        Some(b) => format!("{files} You also have {b}, which quitting will terminate."),
        None => files,
    }
}

/// **Save and Quit**: ask every Window to save, then quit once nothing is
/// unsaved. If a save does not land in time (a write failed, a webview is
/// hung), stay open and say so — never quit over edits the user asked to keep.
pub fn save_all_then_quit(app: &AppHandle<Wry>, quit: fn(&AppHandle<Wry>)) {
    for label in app.webview_windows().keys() {
        if markdown_windows::is_markdown_window_label(label) {
            let _ = app.emit_to(label.as_str(), MARKDOWN_WINDOW_SAVE, ());
        } else if is_profile_window_label(label) {
            let _ = app.emit_to(label.as_str(), SAVE_ALL_BEFORE_QUIT, ());
        }
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + SAVE_TIMEOUT;
        loop {
            if unsaved_paths(&app).is_empty() {
                quit(&app);
                return;
            }
            if Instant::now() >= deadline {
                // Staying open: let a later Cmd+Q ask again.
                if let Some(flag) = app.try_state::<crate::profile_store::QuitConfirmInFlight>() {
                    *flag.0.lock().unwrap() = false;
                }
                use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                app.dialog()
                    .message(unsaved_quit_message(&unsaved_paths(&app), None)
                        + " Abundio could not save them, so it did not quit.")
                    .title("Could not save")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
                return;
            }
            std::thread::sleep(SAVE_POLL);
        }
    });
}

/// A Profile window mirrors the paths of its unsaved File panes. Other
/// windows are ignored: Markdown windows report through `md_window_set_dirty`.
#[tauri::command]
pub async fn report_unsaved_files(
    window: Window,
    state: State<'_, UnsavedFilesState>,
    paths: Vec<String>,
) -> Result<(), AbundioError> {
    let label = window.label().to_string();
    if is_profile_window_label(&label) {
        state.set_for_window(&label, paths);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn message_names_up_to_three_files() {
        assert_eq!(
            unsaved_quit_message(&p(&["/r/a.md"]), None),
            "“a.md” has unsaved changes."
        );
        assert_eq!(
            unsaved_quit_message(&p(&["/r/a.md", "/r/b.ts"]), None),
            "“a.md” and “b.ts” have unsaved changes."
        );
        assert_eq!(
            unsaved_quit_message(&p(&["/a", "/b", "/c"]), None),
            "“a”, “b” and “c” have unsaved changes."
        );
        assert_eq!(
            unsaved_quit_message(&p(&["/a", "/b", "/c", "/d"]), None),
            "“a”, “b” and 2 other files have unsaved changes."
        );
    }

    #[test]
    fn message_adds_busy_work() {
        assert_eq!(
            unsaved_quit_message(&p(&["/r/a.md"]), Some("1 working agent")),
            "“a.md” has unsaved changes. You also have 1 working agent, which quitting will terminate."
        );
    }

    #[test]
    fn state_drops_a_window_with_nothing_unsaved() {
        let s = UnsavedFilesState::default();
        s.set_for_window("main", p(&["/a"]));
        s.set_for_window("window-2", p(&["/b"]));
        assert_eq!(s.all(), p(&["/a", "/b"]));
        s.set_for_window("main", vec![]);
        assert_eq!(s.all(), p(&["/b"]));
        s.remove_for_window("window-2");
        assert!(s.all().is_empty());
    }
    #[test]
    fn quit_choice_reads_both_answer_shapes() {
        use tauri_plugin_dialog::MessageDialogResult as R;
        assert_eq!(quit_choice(&R::Yes), QuitChoice::Save);
        assert_eq!(quit_choice(&R::Custom(SAVE_AND_QUIT.into())), QuitChoice::Save);
        assert_eq!(quit_choice(&R::No), QuitChoice::Discard);
        assert_eq!(
            quit_choice(&R::Custom(QUIT_WITHOUT_SAVING.into())),
            QuitChoice::Discard
        );
        assert_eq!(quit_choice(&R::Cancel), QuitChoice::Cancel);
        assert_eq!(quit_choice(&R::Custom("Cancel".into())), QuitChoice::Cancel);
        assert_eq!(quit_choice(&R::Ok), QuitChoice::Cancel);
    }
}
