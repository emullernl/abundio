//! The **Orchestrator workspace** (ADR-0057): one per Profile, in a folder
//! Abundio owns under the app data folder, with instructions Abundio rewrites
//! on every start and a file of the user's own that it never touches.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::error::AbundioError;
use crate::prompt_actions::PromptActionStore;
use crate::workspace_store::{
    NewOrchestratorTab, OrchestratorTab, WorkspaceStore, WorkspaceWithTabs,
};

/// Name of the Orchestrator's own folder, under `orchestrator/<profile-id>/`.
const FOLDER_NAME: &str = "Orchestrator";

/// The file the user may edit. Created once, never rewritten.
pub const USER_FILE: &str = "my-instructions.md";

/// Folder of a Profile's Orchestrator workspace, inside `root`
/// (`app_paths::shared_root()` in the app). The Profile id is a UUID, so it is
/// always a safe single path component; anything else is refused.
pub fn orchestrator_folder(root: &Path, profile_id: &str) -> Result<PathBuf, AbundioError> {
    let safe = !profile_id.is_empty()
        && profile_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !safe {
        return Err(AbundioError::InvalidOperation(format!(
            "Not a Profile id: {profile_id:?}"
        )));
    }
    // The last part is a name, not the id: a shell's title is its folder's
    // name, and an id there reads as noise.
    Ok(root.join("orchestrator").join(profile_id).join(FOLDER_NAME))
}

const AGENTS_MD: &str = r#"<!-- Written by Abundio on every start. Edits here are lost: put yours in my-instructions.md. -->
# You are the Orchestrator

You run inside Abundio, a desktop app where the user works with several coding
agents at once. Your job is to help the user keep track of those agents and
act through them. You are not working on any project yourself, and this
folder holds no project.

## How to help

- Use the `abundio` command (see the abundio skill) to find out what the
  agents are doing: `abundio workspace list`, then `abundio pane list
  --workspace <name>`, `abundio pane read <agent> --workspace <name>`.
- Answer in plain, friendly language. The user may have no coding or agent
  experience: avoid jargon, say what an agent is doing and whether it needs
  the user, and keep answers short.
- To show the user a file, use `abundio file open <path> --workspace <name>
  --focus`, with `<path>` relative to that Workspace's folder (or absolute).

## Ask before you act

Looking is always fine: listing, reading output, reading notes.

Before you **prompt** another agent, **send it keys**, **start**, **restart**
or **close** an agent or pane, or **close** a workspace, say in one sentence
what you are about to do and wait for the user to say yes. Do it only after
they agree. If the user already told you to do exactly that, you do not need
to ask again.

## The user's own instructions

The user's own instructions are in `my-instructions.md` in this folder. Read
it and follow it; where it disagrees with this file, it wins.
"#;

const CLAUDE_MD: &str = r#"<!-- Written by Abundio on every start. Put your own instructions in my-instructions.md. -->
@AGENTS.md
@my-instructions.md
"#;

const USER_MD: &str = r#"# My instructions for the Orchestrator

Write anything here you want the Orchestrator to know or always do.
Abundio never changes this file.
"#;

/// Creates `folder` if needed, rewrites Abundio's own instruction files, and
/// creates the user's file only when it does not exist yet.
pub fn write_instructions(folder: &Path) -> Result<(), AbundioError> {
    fs::create_dir_all(folder)?;
    fs::write(folder.join("AGENTS.md"), AGENTS_MD)?;
    fs::write(folder.join("CLAUDE.md"), CLAUDE_MD)?;
    let user = folder.join(USER_FILE);
    if !user.exists() {
        fs::write(user, USER_MD)?;
    }
    Ok(())
}

/// Ensures `profile_id`'s Orchestrator workspace: its folder, its
/// instructions and its database row. Returns the Workspace.
pub fn ensure(
    store: &WorkspaceStore,
    root: &Path,
    profile_id: &str,
) -> Result<WorkspaceWithTabs, AbundioError> {
    let folder = orchestrator_folder(root, profile_id)?;
    write_instructions(&folder)?;
    store.ensure_orchestrator(profile_id, &folder.to_string_lossy())
}

// ── Commands ──

#[tauri::command]
pub async fn orchestrator_ensure(
    app: tauri::AppHandle,
    store: State<'_, WorkspaceStore>,
    actions: State<'_, PromptActionStore>,
    profile_id: String,
) -> Result<WorkspaceWithTabs, AbundioError> {
    let ws = ensure(&store, &crate::app_paths::shared_root(), &profile_id)?;
    // The suggested questions, the first time any Orchestrator is set up. A
    // failure here must not keep the Orchestrator from starting.
    match actions.seed_orchestrator_actions() {
        Ok(true) => crate::prompt_actions::broadcast(&app),
        Ok(false) => {}
        Err(e) => log::warn!("[orchestrator] could not seed prompt actions: {e}"),
    }
    Ok(ws)
}

#[tauri::command]
pub async fn orchestrator_agent_get(
    store: State<'_, WorkspaceStore>,
    profile_id: String,
) -> Result<Option<String>, AbundioError> {
    store.orchestrator_agent(&profile_id)
}

#[tauri::command]
pub async fn orchestrator_agent_set(
    store: State<'_, WorkspaceStore>,
    profile_id: String,
    agent_id: Option<String>,
) -> Result<(), AbundioError> {
    store.set_orchestrator_agent(&profile_id, agent_id.as_deref())
}

/// The Profile's Orchestrator file tabs and the selected one (`None`: the
/// graph).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorTabs {
    pub tabs: Vec<OrchestratorTab>,
    pub selected: Option<String>,
}

#[tauri::command]
pub async fn orchestrator_tabs_list(
    store: State<'_, WorkspaceStore>,
    profile_id: String,
) -> Result<OrchestratorTabs, AbundioError> {
    let (tabs, selected) = store.orchestrator_tabs(&profile_id)?;
    Ok(OrchestratorTabs { tabs, selected })
}

#[tauri::command]
pub async fn orchestrator_tab_add(
    store: State<'_, WorkspaceStore>,
    profile_id: String,
    mut tab: NewOrchestratorTab,
) -> Result<OrchestratorTab, AbundioError> {
    let root = store
        .root_folder_of(&tab.workspace_id)?
        .ok_or_else(|| AbundioError::NotFound(format!("Workspace not found: {}", tab.workspace_id)))?;
    tab.path = checked_tab_path(Path::new(&root), &tab.kind, &tab.path)?;
    store.add_orchestrator_tab(&profile_id, tab)
}

/// A tab's path, checked to lie inside its Workspace's folder before it is
/// stored (tabs reopen at every start): a file tab's absolute path, as
/// `file open` resolves it; a diff or commit tab's Workspace-relative path,
/// with no `..` and not absolute.
pub fn checked_tab_path(root: &Path, kind: &str, path: &str) -> Result<String, AbundioError> {
    if kind == "file" {
        return crate::agent_control::resolve_workspace_file(root, None, path, true)
            .map(|(absolute, _)| absolute)
            .map_err(|(_, why)| AbundioError::InvalidOperation(why));
    }
    let rel = Path::new(path);
    let clean = !path.is_empty()
        && rel.components().all(|c| matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir));
    if !clean {
        return Err(AbundioError::InvalidOperation(format!(
            "Not a path inside the Workspace: {path}"
        )));
    }
    Ok(path.to_string())
}

#[tauri::command]
pub async fn orchestrator_tab_remove(
    store: State<'_, WorkspaceStore>,
    profile_id: String,
    id: String,
) -> Result<(), AbundioError> {
    store.remove_orchestrator_tab(&profile_id, &id)
}

#[tauri::command]
pub async fn orchestrator_tab_select(
    store: State<'_, WorkspaceStore>,
    profile_id: String,
    id: Option<String>,
) -> Result<(), AbundioError> {
    store.set_orchestrator_selected_tab(&profile_id, id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tab_path_must_lie_inside_its_workspace() {
        let root = std::env::temp_dir().join(format!("abundio-tab-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.ts"), "x").unwrap();
        let inside = root.join("src/a.ts").to_string_lossy().into_owned();
        assert_eq!(checked_tab_path(&root, "file", &inside).unwrap(), inside);
        assert!(checked_tab_path(&root, "file", "/etc/hosts").is_err());
        assert!(checked_tab_path(&root, "file", &format!("{}/../x", root.display())).is_err());
        assert_eq!(checked_tab_path(&root, "diff", "src/a.ts").unwrap(), "src/a.ts");
        assert!(checked_tab_path(&root, "diff", "../x").is_err());
        assert!(checked_tab_path(&root, "commit", "/etc/hosts").is_err());
        assert!(checked_tab_path(&root, "diff", "").is_err());
        std::fs::remove_dir_all(&root).ok();
    }
    use rusqlite::Connection;

    const PID: &str = "00000000-0000-0000-0000-000000000001";

    fn test_store() -> WorkspaceStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        WorkspaceStore::new(conn)
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("abundio-orch-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn folder_refuses_anything_but_an_id() {
        let root = Path::new("/data");
        assert_eq!(
            orchestrator_folder(root, PID).unwrap(),
            root.join("orchestrator").join(PID).join("Orchestrator")
        );
        for bad in ["", "..", "a/b", "../x", "a b"] {
            assert!(orchestrator_folder(root, bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn ensure_is_idempotent_and_one_per_profile() {
        let store = test_store();
        let root = temp_root("idem");
        let a = ensure(&store, &root, PID).unwrap();
        let b = ensure(&store, &root, PID).unwrap();
        assert_eq!(a.workspace.id, b.workspace.id);
        assert_eq!(a.workspace.kind, "orchestrator");
        assert_eq!(a.tabs.len(), 1);
        let all = store.list(PID).unwrap();
        assert_eq!(
            all.iter()
                .filter(|w| w.workspace.kind == "orchestrator")
                .count(),
            1
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn ordinary_workspaces_are_work() {
        let store = test_store();
        let ws = store.create("w", "/w", PID).unwrap();
        assert_eq!(ws.workspace.kind, "work");
    }

    #[test]
    fn ensure_repoints_a_moved_folder() {
        let store = test_store();
        let root = temp_root("index");
        ensure(&store, &root, PID).unwrap();
        // Finds the existing row rather than inserting a second one.
        let again = store.ensure_orchestrator(PID, "/elsewhere").unwrap();
        assert_eq!(again.workspace.root_folder, "/elsewhere");
        assert_eq!(store.list(PID).unwrap().len(), 1);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn instructions_are_rewritten_but_the_user_file_is_kept() {
        let root = temp_root("instr");
        let folder = orchestrator_folder(&root, PID).unwrap();
        write_instructions(&folder).unwrap();
        fs::write(folder.join("AGENTS.md"), "stale").unwrap();
        fs::write(folder.join(USER_FILE), "mine").unwrap();
        write_instructions(&folder).unwrap();
        assert_eq!(
            fs::read_to_string(folder.join("AGENTS.md")).unwrap(),
            AGENTS_MD
        );
        assert_eq!(fs::read_to_string(folder.join(USER_FILE)).unwrap(), "mine");
        assert!(fs::read_to_string(folder.join("CLAUDE.md"))
            .unwrap()
            .contains("@AGENTS.md"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn file_tabs_are_kept_once_per_file_and_selectable() {
        let store = test_store();
        let ws = store.create("w", "/w", PID).unwrap().workspace.id;
        let new = |path: &str| NewOrchestratorTab {
            workspace_id: ws.clone(),
            kind: "file".into(),
            path: path.into(),
            commit_oid: None,
            preview: false,
        };
        let a = store.add_orchestrator_tab(PID, new("/w/a.md")).unwrap();
        let again = store.add_orchestrator_tab(PID, new("/w/a.md")).unwrap();
        assert_eq!(a.id, again.id);
        let b = store.add_orchestrator_tab(PID, new("/w/b.md")).unwrap();
        store
            .set_orchestrator_selected_tab(PID, Some(&b.id))
            .unwrap();
        let (tabs, selected) = store.orchestrator_tabs(PID).unwrap();
        assert_eq!(
            tabs.iter().map(|t| t.path.as_str()).collect::<Vec<_>>(),
            ["/w/a.md", "/w/b.md"]
        );
        assert_eq!(selected.as_deref(), Some(b.id.as_str()));
        // Closing the selected tab: the selection falls back to the graph.
        store.remove_orchestrator_tab(PID, &b.id).unwrap();
        let (tabs, selected) = store.orchestrator_tabs(PID).unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(selected, None);
        // Not a kind we know.
        assert!(store
            .add_orchestrator_tab(
                PID,
                NewOrchestratorTab {
                    kind: "x".into(),
                    ..new("/w/c")
                }
            )
            .is_err());
    }

    #[test]
    fn a_file_tab_of_another_profiles_workspace_is_refused() {
        let store = test_store();
        let ws = store.create("w", "/w", PID).unwrap().workspace.id;
        let tab = NewOrchestratorTab {
            workspace_id: ws,
            kind: "file".into(),
            path: "/w/a".into(),
            commit_oid: None,
            preview: false,
        };
        assert!(store.add_orchestrator_tab("someone-else", tab).is_err());
    }

    #[test]
    fn the_agent_choice_round_trips() {
        let store = test_store();
        assert_eq!(store.orchestrator_agent(PID).unwrap(), None);
        store.set_orchestrator_agent(PID, Some("claude")).unwrap();
        assert_eq!(
            store.orchestrator_agent(PID).unwrap().as_deref(),
            Some("claude")
        );
        store.set_orchestrator_agent(PID, None).unwrap();
        assert_eq!(store.orchestrator_agent(PID).unwrap(), None);
        assert!(store.set_orchestrator_agent("nope", Some("x")).is_err());
    }
}
