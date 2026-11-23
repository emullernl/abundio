//! The **Orchestrator workspace** (ADR-0057): one per Profile, in its
//! **Orchestrator folder** (ADR-0059: by default `orchestrator/<Profile name>`
//! in the app data folder, or one the user chose), with instructions Abundio
//! rewrites on every start and a file of the user's own that it never touches.

use std::fs;
use std::path::{Path, PathBuf};


use crate::error::AbundioError;
use crate::prompt_actions::PromptActionStore;
use crate::workspace_store::{
    NewOrchestratorTab, OrchestratorTab, WorkspaceStore, WorkspaceWithTabs,
};

/// The file the user may edit. Created once, never rewritten.
pub const USER_FILE: &str = "my-instructions.md";

pub use crate::workspace_folders::MARKER;

/// Files an "empty" folder may still hold: the OS's own, and the marker.
const IGNORED: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini", MARKER];

pub use crate::workspace_folders::default_parent;

/// Whether `folder` is a default one (inside `default_parent`, never that
/// folder itself): Abundio's to delete with its Profile. A folder the user
/// chose never is: `set_folder` refuses one in there. Compared by real path.
pub fn is_default_folder(root: &Path, folder: &Path) -> bool {
    let parent = default_parent(root);
    crate::workspace_folders::is_within(folder, &parent)
        && crate::workspace_folders::folder_key(folder)
            != crate::workspace_folders::folder_key(&parent)
}

/// A Profile's name as one safe folder name: characters no OS allows in a
/// name become `-`; no leading or trailing dots or spaces; never empty.
pub fn folder_name_for(profile_name: &str) -> String {
    let cleaned: String = profile_name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed.is_empty() {
        "Orchestrator".to_string()
    } else {
        trimmed.to_string()
    }
}

/// The marker's Profile id, if `folder` carries one.
fn marker_of(folder: &Path) -> Option<String> {
    fs::read_to_string(folder.join(MARKER))
        .ok()
        .map(|s| s.trim().to_string())
}

/// `profile_id`'s default **Orchestrator folder**: `orchestrator/<name>`, or
/// `<name> 2`, `<name> 3`… when that is taken (exists for another Profile,
/// or `in_use` says another Workspace has it).
pub fn default_folder(
    root: &Path,
    profile_id: &str,
    profile_name: &str,
    in_use: impl Fn(&Path) -> bool,
) -> PathBuf {
    let base = folder_name_for(profile_name);
    let parent = default_parent(root);
    let mut n = 1;
    loop {
        let name = if n == 1 { base.clone() } else { format!("{base} {n}") };
        let candidate = parent.join(name);
        let mine = marker_of(&candidate).as_deref() == Some(profile_id);
        if mine || (!candidate.exists() && !in_use(&candidate)) {
            return candidate;
        }
        n += 1;
    }
}

/// Whether a folder may become an Orchestrator folder: empty (but for the
/// OS's own files), or one Abundio set up as one. A missing folder may.
pub fn folder_is_usable(folder: &Path) -> bool {
    let Ok(entries) = fs::read_dir(folder) else {
        return !folder.exists();
    };
    if folder.join(MARKER).is_file() {
        return true;
    }
    entries.flatten().all(|e| {
        IGNORED
            .iter()
            .any(|n| e.file_name().to_string_lossy() == *n)
    })
}

/// Makes sure `folder` is there before the Orchestrator starts in it: a
/// default one is always made; a chosen one is made again only when its
/// parent still exists, else `FolderMissing` (ADR-0053: never elsewhere).
pub fn prepare_folder(root: &Path, folder: &Path) -> Result<(), AbundioError> {
    if folder.is_dir() {
        return Ok(());
    }
    if is_default_folder(root, folder) {
        fs::create_dir_all(folder)?;
        return Ok(());
    }
    match folder.parent() {
        Some(parent) if parent.is_dir() => {
            fs::create_dir(folder)?;
            Ok(())
        }
        _ => Err(AbundioError::FolderMissing(folder.to_string_lossy().into_owned())),
    }
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
- Workspaces on another machine the user joined are listed as
  `<name>@<host>`: use that name as is (`--workspace app@build-box`,
  `"Reviewer@build-box"`). If such a machine is not connected
  (`host_offline`), say so to the user.
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

/// Rewrites Abundio's own instruction files and the marker in `folder`
/// (which must exist), and creates the user's file only when it does not
/// exist yet.
pub fn write_instructions(folder: &Path, profile_id: &str) -> Result<(), AbundioError> {
    fs::write(folder.join(MARKER), format!("{profile_id}\n"))?;
    fs::write(folder.join("AGENTS.md"), AGENTS_MD)?;
    fs::write(folder.join("CLAUDE.md"), CLAUDE_MD)?;
    let user = folder.join(USER_FILE);
    if !user.exists() {
        fs::write(user, USER_MD)?;
    }
    Ok(())
}

/// Ensures `profile_id`'s Orchestrator workspace: its folder, its
/// instructions and its database row. Returns the Workspace. A Profile keeps
/// the folder it has (one from before ADR-0059 too); a new one gets its
/// default folder.
pub fn ensure(
    store: &WorkspaceStore,
    root: &Path,
    profile_id: &str,
) -> Result<WorkspaceWithTabs, AbundioError> {
    let folder = match store.orchestrator_folder_of(profile_id)? {
        Some(f) => PathBuf::from(f),
        None => new_default(store, root, profile_id)?,
    };
    prepare_folder(root, &folder)?;
    write_instructions(&folder, profile_id)?;
    store.ensure_orchestrator(profile_id, &folder.to_string_lossy())
}

fn new_default(store: &WorkspaceStore, root: &Path, profile_id: &str) -> Result<PathBuf, AbundioError> {
    let name = store.profile_name(profile_id)?.unwrap_or_default();
    Ok(default_folder(root, profile_id, &name, |p| {
        store
            .folder_in_use(&p.to_string_lossy(), profile_id)
            .unwrap_or(true)
    }))
}

/// Moves `profile_id`'s Orchestrator to `chosen`, or back to its default
/// folder (`None`). Only an empty folder or an Orchestrator folder of its
/// own, not bound to another Workspace. Copies `my-instructions.md` across
/// when the new folder has none; the old folder is left as it was. Returns
/// the new folder.
pub fn set_folder(
    store: &WorkspaceStore,
    root: &Path,
    profile_id: &str,
    chosen: Option<&Path>,
) -> Result<PathBuf, AbundioError> {
    let current = ensure(store, root, profile_id)
        .map(|ws| PathBuf::from(ws.workspace.root_folder))
        .or_else(|e| match e {
            // A missing current folder is exactly when one is chosen.
            AbundioError::FolderMissing(p) => Ok(PathBuf::from(p)),
            e => Err(e),
        })?;
    let target = match chosen {
        None => new_default(store, root, profile_id)?,
        Some(p) => {
            if !p.is_absolute() {
                return Err(AbundioError::InvalidOperation(
                    "Choose a folder by its full path".into(),
                ));
            }
            // Abundio's own folder for default ones is not the user's to
            // choose: a Profile's default could land inside it, and a
            // chosen folder there would count as Abundio's to delete.
            if crate::workspace_folders::is_within(p, &default_parent(root)) {
                return Err(AbundioError::InvalidOperation(
                    "Choose a folder outside Abundio's own; Reset to default goes back there".into(),
                ));
            }
            // The Workspace folder rule's own comparison (real path, case,
            // trailing slash), so both sides agree on "the same folder".
            let key = crate::workspace_folders::folder_key(p);
            let own = store.orchestrator_workspace_id(profile_id)?;
            let clash = store.all_folders()?.into_iter().any(|r| {
                Some(&r.id) != own.as_ref()
                    && crate::workspace_folders::folder_key(Path::new(&r.root_folder)) == key
            });
            if clash {
                return Err(AbundioError::InvalidOperation(
                    "That folder already belongs to a Workspace".into(),
                ));
            }
            if let Some(owner) = marker_of(p) {
                if owner != profile_id && store.profile_name(&owner)?.is_some() {
                    return Err(AbundioError::InvalidOperation(
                        "That folder is another Profile's Orchestrator folder".into(),
                    ));
                }
            }
            if !folder_is_usable(p) {
                return Err(AbundioError::InvalidOperation(
                    "Choose an empty folder: Abundio writes the Orchestrator's own AGENTS.md and CLAUDE.md there".into(),
                ));
            }
            p.to_path_buf()
        }
    };
    if target == current {
        return Ok(target);
    }
    prepare_folder(root, &target)?;
    let mine = current.join(USER_FILE);
    let theirs = target.join(USER_FILE);
    if mine.is_file() && !theirs.exists() {
        fs::copy(&mine, &theirs)?;
    }
    write_instructions(&target, profile_id)?;
    store.ensure_orchestrator(profile_id, &target.to_string_lossy())?;
    Ok(target)
}

/// Deletes `profile_id`'s Orchestrator folder when it is a default one,
/// before the Profile itself goes. A folder the user chose is theirs.
pub fn forget_folder(store: &WorkspaceStore, root: &Path, profile_id: &str) {
    if let Ok(Some(folder)) = store.orchestrator_folder_of(profile_id) {
        forget_folder_at(root, Path::new(&folder));
    }
}

/// `forget_folder` for a folder already looked up.
pub fn forget_folder_at(root: &Path, folder: &Path) {
    if is_default_folder(root, folder) && folder.is_dir() {
        if let Err(e) = fs::remove_dir_all(folder) {
            log::warn!("[orchestrator] could not delete {}: {e}", folder.display());
        }
    }
}

// ── Commands ──
pub fn orchestrator_ensure(
    events: &crate::event_sink::Events,
    store: &WorkspaceStore,
    actions: &PromptActionStore,
    profile_id: String,
) -> Result<WorkspaceWithTabs, AbundioError> {
    let ws = ensure(store, &crate::app_paths::shared_root(), &profile_id)?;
    // The suggested questions, the first time any Orchestrator is set up. A
    // failure here must not keep the Orchestrator from starting.
    match actions.seed_orchestrator_actions() {
        Ok(true) => crate::prompt_actions::broadcast(events),
        Ok(false) => {}
        Err(e) => log::warn!("[orchestrator] could not seed prompt actions: {e}"),
    }
    Ok(ws)
}

/// A Profile's **Orchestrator folder**, for Settings ▸ Profiles.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorFolder {
    pub path: String,
    /// Inside Abundio's data folder (not one the user chose).
    pub is_default: bool,
    /// Where Reset to default would put it: `orchestrator/<Profile name>`.
    /// Differs from `path` for a chosen folder, and for a Profile from before
    /// ADR-0059 still in `orchestrator/<id>/Orchestrator`.
    pub default_path: String,
}

fn describe(store: &WorkspaceStore, root: &Path, profile_id: &str, path: PathBuf) -> Result<OrchestratorFolder, AbundioError> {
    Ok(OrchestratorFolder {
        is_default: is_default_folder(root, &path),
        default_path: new_default(store, root, profile_id)?.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
    })
}
pub fn orchestrator_folder_get(
    store: &WorkspaceStore,
    profile_id: String,
) -> Result<OrchestratorFolder, AbundioError> {
    let root = crate::app_paths::shared_root();
    // Not set up yet: where it would go, without making anything.
    let path = match store.orchestrator_folder_of(&profile_id)? {
        Some(f) => PathBuf::from(f),
        None => new_default(store, &root, &profile_id)?,
    };
    describe(store, &root, &profile_id, path)
}

/// Chooses the Profile's Orchestrator folder (`None`: back to the default),
/// then tells every Window, so the one running it restarts it there.
pub fn orchestrator_folder_set(
    events: &crate::event_sink::Events,
    store: &WorkspaceStore,
    profile_id: String,
    path: Option<String>,
) -> Result<OrchestratorFolder, AbundioError> {
    use crate::event_sink::EventsExt;
    let root = crate::app_paths::shared_root();
    let folder = set_folder(store, &root, &profile_id, path.as_deref().map(Path::new))?;
    let out = describe(store, &root, &profile_id, folder)?;
    events.broadcast(
        "orchestrator-folder-changed",
        serde_json::json!({ "profileId": profile_id, "path": out.path }),
    );
    Ok(out)
}
pub fn orchestrator_agent_get(
    store: &WorkspaceStore,
    profile_id: String,
) -> Result<Option<String>, AbundioError> {
    store.orchestrator_agent(&profile_id)
}
pub fn orchestrator_agent_set(
    store: &WorkspaceStore,
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
pub fn orchestrator_tabs_list(
    store: &WorkspaceStore,
    profile_id: String,
) -> Result<OrchestratorTabs, AbundioError> {
    let (tabs, selected) = store.orchestrator_tabs(&profile_id)?;
    Ok(OrchestratorTabs { tabs, selected })
}
pub fn orchestrator_tab_add(
    store: &WorkspaceStore,
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
        return crate::control_protocol::resolve_workspace_file(root, None, path, true)
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
pub fn orchestrator_tab_remove(
    store: &WorkspaceStore,
    profile_id: String,
    id: String,
) -> Result<(), AbundioError> {
    store.remove_orchestrator_tab(&profile_id, &id)
}
pub fn orchestrator_tab_set_view(
    store: &WorkspaceStore,
    profile_id: String,
    id: String,
    view: crate::workspace_store::MarkdownView,
) -> Result<(), AbundioError> {
    store.set_orchestrator_tab_view(&profile_id, &id, view)
}
pub fn orchestrator_tab_select(
    store: &WorkspaceStore,
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
    fn a_profile_name_becomes_one_safe_folder_name() {
        assert_eq!(folder_name_for("Personal"), "Personal");
        assert_eq!(folder_name_for("Work / Client: A"), "Work - Client- A");
        assert_eq!(folder_name_for("  ..hidden. "), "hidden");
        assert_eq!(folder_name_for("../.."), "-");
        assert_eq!(folder_name_for("   "), "Orchestrator");
    }

    #[test]
    fn a_new_profile_gets_its_name_and_a_taken_name_a_number() {
        let store = test_store();
        let root = temp_root("named");
        let name = store.profile_name(PID).unwrap().unwrap();
        let ws = ensure(&store, &root, PID).unwrap();
        let folder = PathBuf::from(&ws.workspace.root_folder);
        assert_eq!(folder, default_parent(&root).join(folder_name_for(&name)));
        assert_eq!(marker_of(&folder).as_deref(), Some(PID));
        // Its own folder stays its default; another Profile with the same
        // name gets a number.
        assert_eq!(default_folder(&root, PID, &name, |_| false), folder);
        assert_eq!(
            default_folder(&root, "other", &name, |_| false),
            default_parent(&root).join(format!("{} 2", folder_name_for(&name)))
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_profile_from_before_keeps_its_folder() {
        let store = test_store();
        let root = temp_root("old");
        let old = default_parent(&root).join(PID).join("Orchestrator");
        store.ensure_orchestrator(PID, &old.to_string_lossy()).unwrap();
        let ws = ensure(&store, &root, PID).unwrap();
        assert_eq!(PathBuf::from(ws.workspace.root_folder), old);
        assert!(old.join("AGENTS.md").is_file());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn only_an_empty_folder_or_an_orchestrator_folder_may_be_chosen() {
        let store = test_store();
        let root = temp_root("choose");
        let first = PathBuf::from(ensure(&store, &root, PID).unwrap().workspace.root_folder);
        fs::write(first.join(USER_FILE), "mine").unwrap();

        // A project folder: refused, and nothing written into it.
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("CLAUDE.md"), "the project's own").unwrap();
        assert!(set_folder(&store, &root, PID, Some(&project)).is_err());
        assert_eq!(fs::read_to_string(project.join("CLAUDE.md")).unwrap(), "the project's own");

        // Another Workspace's folder: refused.
        let work = root.join("work");
        fs::create_dir_all(&work).unwrap();
        store.create("w", &work.to_string_lossy(), PID).unwrap();
        assert!(set_folder(&store, &root, PID, Some(&work)).is_err());

        // An empty one (but for the OS's own files): chosen, my-instructions
        // copied, the old folder left as it was.
        let mine = root.join("mine");
        fs::create_dir_all(&mine).unwrap();
        fs::write(mine.join(".DS_Store"), "").unwrap();
        assert_eq!(set_folder(&store, &root, PID, Some(&mine)).unwrap(), mine);
        assert_eq!(fs::read_to_string(mine.join(USER_FILE)).unwrap(), "mine");
        assert!(first.join(USER_FILE).is_file());
        assert_eq!(store.orchestrator_folder_of(PID).unwrap(), Some(mine.to_string_lossy().into()));

        // Now it carries the marker, so it may be chosen again later; back
        // to the default meanwhile.
        assert_eq!(set_folder(&store, &root, PID, None).unwrap(), first);
        assert!(folder_is_usable(&mine));
        assert_eq!(set_folder(&store, &root, PID, Some(&mine)).unwrap(), mine);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn abundios_own_folder_is_never_a_chosen_one() {
        let store = test_store();
        let root = temp_root("own");
        ensure(&store, &root, PID).unwrap();
        // The parent of every default folder, or one inside it: refused.
        assert!(set_folder(&store, &root, PID, Some(&default_parent(&root))).is_err());
        let inside = default_parent(&root).join("mine");
        assert!(set_folder(&store, &root, PID, Some(&inside)).is_err());
        // And the parent itself is never "a default folder" to delete.
        assert!(!is_default_folder(&root, &default_parent(&root)));
        assert!(is_default_folder(&root, &default_parent(&root).join("P")));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_workspace_folder_written_differently_is_still_refused() {
        let store = test_store();
        let root = temp_root("same");
        ensure(&store, &root, PID).unwrap();
        let work = root.join("work");
        fs::create_dir_all(&work).unwrap();
        store.create("w", &work.to_string_lossy(), PID).unwrap();
        let trailing = PathBuf::from(format!("{}/", work.display()));
        assert!(set_folder(&store, &root, PID, Some(&trailing)).is_err());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_missing_folder_is_made_again_only_where_it_can_be() {
        let root = temp_root("missing");
        // A default one: always made.
        let default = default_parent(&root).join("Personal");
        prepare_folder(&root, &default).unwrap();
        assert!(default.is_dir());
        // A chosen one whose parent is there: made again.
        let chosen = root.join("chosen");
        prepare_folder(&root, &chosen).unwrap();
        assert!(chosen.is_dir());
        // Its parent gone too (an unplugged drive): refused, nothing made.
        let gone = root.join("unplugged").join("Orchestrator");
        assert!(matches!(
            prepare_folder(&root, &gone),
            Err(AbundioError::FolderMissing(_))
        ));
        assert!(!root.join("unplugged").exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn deleting_a_profile_deletes_a_default_folder_only() {
        let store = test_store();
        let root = temp_root("forget");
        let folder = PathBuf::from(ensure(&store, &root, PID).unwrap().workspace.root_folder);
        forget_folder(&store, &root, PID);
        assert!(!folder.exists());

        let store = test_store();
        let chosen = root.join("chosen");
        fs::create_dir_all(&chosen).unwrap();
        ensure(&store, &root, PID).unwrap();
        set_folder(&store, &root, PID, Some(&chosen)).unwrap();
        forget_folder(&store, &root, PID);
        assert!(chosen.join(USER_FILE).is_file());
        fs::remove_dir_all(root).ok();
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
        let folder = default_parent(&root).join("Personal");
        prepare_folder(&root, &folder).unwrap();
        write_instructions(&folder, PID).unwrap();
        fs::write(folder.join("AGENTS.md"), "stale").unwrap();
        fs::write(folder.join(USER_FILE), "mine").unwrap();
        write_instructions(&folder, PID).unwrap();
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
            view: None,
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
    fn a_file_tabs_view_is_remembered() {
        use crate::workspace_store::MarkdownView::{Rendered, Source};
        let store = test_store();
        let ws = store.create("w", "/w", PID).unwrap().workspace.id;
        let new = |view| NewOrchestratorTab {
            workspace_id: ws.clone(),
            kind: "file".into(),
            path: "/w/a.md".into(),
            commit_oid: None,
            view,
        };
        // No view: follow the setting.
        let a = store.add_orchestrator_tab(PID, new(None)).unwrap();
        assert_eq!(a.view, None);
        store.set_orchestrator_tab_view(PID, &a.id, Source).unwrap();
        let (tabs, _) = store.orchestrator_tabs(PID).unwrap();
        assert_eq!(tabs[0].view, Some(Source));
        // Opened again with no view: the tab keeps its own.
        let again = store.add_orchestrator_tab(PID, new(None)).unwrap();
        assert_eq!(again.view, Some(Source));
        // Opened again with one (`file open --preview`): it takes that one.
        let pinned = store.add_orchestrator_tab(PID, new(Some(Rendered))).unwrap();
        assert_eq!(pinned.id, a.id);
        assert_eq!(pinned.view, Some(Rendered));
        let (tabs, _) = store.orchestrator_tabs(PID).unwrap();
        assert_eq!(tabs[0].view, Some(Rendered));
        // A tab that is not there, or another Profile's: not found.
        assert!(matches!(
            store.set_orchestrator_tab_view(PID, "nope", Source),
            Err(AbundioError::NotFound(_))
        ));
        assert!(matches!(
            store.set_orchestrator_tab_view("someone-else", &a.id, Source),
            Err(AbundioError::NotFound(_))
        ));
    }

    #[test]
    fn a_tab_view_that_is_not_a_view_is_refused_at_the_ipc_edge() {
        let bad: Result<NewOrchestratorTab, _> = serde_json::from_str(
            r#"{"workspaceId":"w","kind":"file","path":"/w/a.md","view":"split"}"#,
        );
        assert!(bad.is_err());
    }

    #[test]
    fn a_tab_that_asked_for_a_preview_opens_rendered_after_the_migration() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE orchestrator_tabs (id TEXT PRIMARY KEY, preview INTEGER NOT NULL DEFAULT 0);
             INSERT INTO orchestrator_tabs (id, preview) VALUES ('p', 1), ('q', 0);",
        )
        .unwrap();
        conn.execute_batch(include_str!("../migrations/024_orchestrator_tab_view.sql"))
            .unwrap();
        let view = |id: &str| -> Option<String> {
            conn.query_row("SELECT view FROM orchestrator_tabs WHERE id = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(view("p").as_deref(), Some("rendered"));
        assert_eq!(view("q"), None);
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
            view: None,
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
