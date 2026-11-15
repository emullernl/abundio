//! Which folder a **Workspace** may have (GLOSSARY.md, Workspace): never one
//! another Workspace of its Profile already has, never an **Orchestrator
//! folder**; another Profile's Workspace may share it (the user is told).
//! Checked in Rust wherever a Workspace's folder is set, so every way in
//! (the New Workspace dialog, discovered and new worktrees, New task,
//! `abundio worktree new`) obeys it.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::error::AbundioError;
use crate::orchestrator::{default_parent, MARKER};
use crate::workspace_store::{FolderRow, WorkspaceStore};

/// `path` as one comparable key: the real path when it exists (symlinks
/// resolved), else lexically cleaned; no trailing separator; folded to lower
/// case where the file system usually ignores case (macOS, Windows).
pub fn folder_key(path: &Path) -> String {
    let real = real_path(&clean(path));
    let s = real.to_string_lossy();
    let s = s.trim_end_matches(['/', '\\']);
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// `path` with its longest existing start resolved (symlinks and all), and
/// the rest, which does not exist yet, appended as written.
fn real_path(path: &Path) -> PathBuf {
    let mut base = path.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(real) = base.canonicalize() {
            return rest.iter().rev().fold(real, |p, part| p.join(part));
        }
        match (base.file_name().map(|n| n.to_owned()), base.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                base = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

fn clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Whether `folder` is, or is inside, `parent` (by `folder_key`).
pub fn is_within(folder: &Path, parent: &Path) -> bool {
    let (f, p) = (folder_key(folder), folder_key(parent));
    f == p || f.starts_with(&format!("{p}/")) || f.starts_with(&format!("{p}\\"))
}

/// The Workspace that already has a folder.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TakenBy {
    pub id: String,
    pub name: String,
}

/// What adding (or moving) a Workspace to a folder would meet.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderCheck {
    /// A Workspace of the same Profile already has it: refused.
    pub taken_by: Option<TakenBy>,
    /// It is an **Orchestrator folder**: refused.
    pub orchestrator: bool,
    /// Other Profiles with a Workspace there: allowed, the user is told.
    pub other_profiles: Vec<String>,
}

/// Checks `folder` for a Workspace of `profile_id` against `rows` (every
/// Workspace), `except` being the Workspace that is moving, if any. Pure but
/// for reading the folder's marker and resolving paths.
pub fn check_against(
    rows: &[FolderRow],
    data_root: &Path,
    folder: &Path,
    profile_id: &str,
    except: Option<&str>,
) -> FolderCheck {
    let key = folder_key(folder);
    let mut out = FolderCheck {
        orchestrator: is_within(folder, &default_parent(data_root))
            || folder.join(MARKER).is_file(),
        ..Default::default()
    };
    for row in rows {
        if Some(row.id.as_str()) == except || folder_key(Path::new(&row.root_folder)) != key {
            continue;
        }
        if row.kind == "orchestrator" {
            out.orchestrator = true;
        } else if row.profile_id == profile_id {
            out.taken_by.get_or_insert(TakenBy {
                id: row.id.clone(),
                name: row.name.clone(),
            });
        } else if !out.other_profiles.contains(&row.profile_name) {
            out.other_profiles.push(row.profile_name.clone());
        }
    }
    out
}

/// `check_against` over the database.
pub fn check(
    store: &WorkspaceStore,
    data_root: &Path,
    folder: &str,
    profile_id: &str,
    except: Option<&str>,
) -> Result<FolderCheck, AbundioError> {
    Ok(check_against(
        &store.all_folders()?,
        data_root,
        Path::new(folder),
        profile_id,
        except,
    ))
}

/// The prefix of the refusal for a folder its Profile already has; the
/// frontend reads the Workspace id after it to offer opening that one.
pub const FOLDER_TAKEN_CODE: &str = "E_FOLDER_TAKEN";

/// Refuses what `check` says must be refused.
pub fn enforce(c: &FolderCheck) -> Result<(), AbundioError> {
    if c.orchestrator {
        return Err(AbundioError::InvalidOperation(
            "This is the Orchestrator's folder; choose another".into(),
        ));
    }
    if let Some(t) = &c.taken_by {
        return Err(AbundioError::InvalidOperation(format!(
            "{FOLDER_TAKEN_CODE}:{}: {} already uses this folder",
            t.id, t.name
        )));
    }
    Ok(())
}

/// Whether any Workspace other than an Orchestrator workspace has its folder
/// at or inside `folder`: such a folder is not deleted with its Profile.
pub fn holds_work(rows: &[FolderRow], folder: &Path) -> bool {
    rows.iter()
        .any(|r| r.kind != "orchestrator" && is_within(Path::new(&r.root_folder), folder))
}

#[tauri::command]
pub async fn workspace_folder_check(
    store: tauri::State<'_, WorkspaceStore>,
    root_folder: String,
    profile_id: String,
) -> Result<FolderCheck, AbundioError> {
    check(&store, &crate::app_paths::shared_root(), &root_folder, &profile_id, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, folder: &str, profile: &str, kind: &str) -> FolderRow {
        FolderRow {
            id: id.into(),
            name: format!("ws-{id}"),
            root_folder: folder.into(),
            profile_id: profile.into(),
            profile_name: format!("Profile {profile}"),
            kind: kind.into(),
        }
    }

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("abundio-wf-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_same_folder_however_it_is_written() {
        let d = temp("same");
        let s = d.to_string_lossy().to_string();
        assert_eq!(folder_key(&d), folder_key(Path::new(&format!("{s}/"))));
        assert_eq!(folder_key(&d), folder_key(&d.join("x").join("..")));
        #[cfg(unix)]
        {
            let link = d.with_extension("link");
            std::os::unix::fs::symlink(&d, &link).unwrap();
            assert_eq!(folder_key(&d), folder_key(&link));
            std::fs::remove_file(&link).ok();
        }
        if cfg!(target_os = "macos") {
            assert_eq!(folder_key(&d), folder_key(Path::new(&s.to_uppercase())));
        }
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_profile_never_has_one_folder_twice() {
        let rows = [row("a", "/src/app", "p", "work")];
        let c = check_against(&rows, Path::new("/data"), Path::new("/src/app/"), "p", None);
        assert_eq!(c.taken_by, Some(TakenBy { id: "a".into(), name: "ws-a".into() }));
        assert!(enforce(&c).unwrap_err().to_string().contains("E_FOLDER_TAKEN:a:"));
        // Moving that Workspace itself is not a clash.
        let own = check_against(&rows, Path::new("/data"), Path::new("/src/app"), "p", Some("a"));
        assert!(enforce(&own).is_ok());
    }

    #[test]
    fn another_profile_may_share_it_and_is_named() {
        let rows = [
            row("a", "/src/app", "work", "work"),
            row("b", "/src/app", "home", "work"),
        ];
        let c = check_against(&rows, Path::new("/data"), Path::new("/src/app"), "mine", None);
        assert!(enforce(&c).is_ok());
        assert_eq!(c.other_profiles, ["Profile work", "Profile home"]);
    }

    #[test]
    fn a_nested_folder_is_a_different_folder() {
        let rows = [row("a", "/src/repo", "p", "work")];
        let c = check_against(&rows, Path::new("/data"), Path::new("/src/repo/packages/ui"), "p", None);
        assert_eq!(c, FolderCheck::default());
    }

    #[test]
    fn an_orchestrator_folder_is_never_a_workspace_folder() {
        let data = temp("orch");
        let inside = default_parent(&data).join("Personal");
        let c = check_against(&[], &data, &inside, "p", None);
        assert!(c.orchestrator);
        assert!(enforce(&c).unwrap_err().to_string().contains("Orchestrator's folder"));
        // A chosen one elsewhere: by its row, and by its marker.
        let chosen = temp("chosen");
        let rows = [row("o", &chosen.to_string_lossy(), "other", "orchestrator")];
        assert!(check_against(&rows, &data, &chosen, "p", None).orchestrator);
        std::fs::write(chosen.join(MARKER), "x").unwrap();
        assert!(check_against(&[], &data, &chosen, "p", None).orchestrator);
        std::fs::remove_dir_all(&data).ok();
        std::fs::remove_dir_all(&chosen).ok();
    }

    #[test]
    fn a_folder_holding_a_workspace_is_seen() {
        let rows = [
            row("o", "/data/orchestrator/P", "p", "orchestrator"),
            row("a", "/data/orchestrator/P/stuff", "p", "work"),
        ];
        assert!(holds_work(&rows, Path::new("/data/orchestrator/P")));
        assert!(!holds_work(&rows[..1], Path::new("/data/orchestrator/P")));
    }
}
