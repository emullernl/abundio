//! **Skill provisioning** (ADR-0054): put the Abundio skill where Watched
//! Agents look for skills, the way `agent_hooks` puts in their status hooks.
//!
//! Every built-in Agent reads skills in the shared `SKILL.md` format. All but
//! Claude Code read the shared folder `~/.agents/skills/`, so the one real
//! copy lives at `~/.agents/skills/abundio/`. Claude Code reads only its own
//! `skills/` folder (`$CLAUDE_CONFIG_DIR`, else `~/.claude`), which gets a
//! link to that copy, or a copy of its own where a link cannot be made or
//! there is no shared copy. See `docs/plans/agent-control.md` step 1.
//!
//! A folder is Abundio's only when it carries the marker file (or, for the
//! Claude entry, is a link to the shared copy). One that does not is the
//! user's, and is left alone and reported as a conflict.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::error::AbundioError;

pub const SKILL_NAME: &str = "abundio";
const SKILL_MD: &str = include_str!("../skill/SKILL.md");
pub const MARKER: &str = ".abundio-managed";
const MARKER_TEXT: &str = "This skill folder is written by Abundio and rewritten on every start.\n\
Turn it off in Settings > Agents instead of editing it.\n";

/// Agents that read the shared `~/.agents/skills/` folder.
const SHARED_READERS: &[&str] = &[
    "codex", "copilot", "gemini", "opencode", "qwen", "kimi", "grok", "vibe",
];

/// Once per process, like hook provisioning's startup guard.
#[derive(Default)]
pub struct SkillStartupGuard(AtomicBool);

impl SkillStartupGuard {
    pub fn claim(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }
}

/// Where the skill goes for one user.
#[derive(Clone, Debug)]
pub struct SkillPaths {
    /// `~/.agents/skills/abundio`
    pub shared: PathBuf,
    /// Claude Code's config folder (`$CLAUDE_CONFIG_DIR` or `~/.claude`).
    pub claude_home: PathBuf,
}

impl SkillPaths {
    pub fn for_user() -> Result<Self, AbundioError> {
        let home = dirs::home_dir()
            .ok_or_else(|| AbundioError::Io(io::Error::other("no home directory")))?;
        let claude_home = std::env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"));
        Ok(Self {
            shared: home.join(".agents").join("skills").join(SKILL_NAME),
            claude_home,
        })
    }

    pub fn claude(&self) -> PathBuf {
        self.claude_home.join("skills").join(SKILL_NAME)
    }
}

/// What is at one skill location.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryState {
    /// Nothing there.
    Absent,
    /// Abundio's copy, current.
    Installed,
    /// Abundio's copy, but older than this build's skill text.
    Outdated,
    /// A link to the shared copy (Claude Code only).
    Linked,
    /// Something Abundio did not write: left alone.
    Conflict,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntryStatus {
    /// `shared` or `claude`.
    pub location: &'static str,
    pub path: String,
    pub state: EntryState,
}

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

fn exists_at_all(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn links_to(path: &Path, target: &Path) -> bool {
    is_link(path)
        && fs::read_link(path)
            .map(|t| t == target)
            .unwrap_or(false)
}

fn owned_copy(dir: &Path) -> bool {
    !is_link(dir) && dir.join(MARKER).is_file()
}

fn copy_state(dir: &Path) -> EntryState {
    if !exists_at_all(dir) {
        return EntryState::Absent;
    }
    if !owned_copy(dir) {
        return EntryState::Conflict;
    }
    match fs::read_to_string(dir.join("SKILL.md")) {
        Ok(text) if text == SKILL_MD => EntryState::Installed,
        _ => EntryState::Outdated,
    }
}

fn entry_state(paths: &SkillPaths, location: &str) -> EntryState {
    if location == "shared" {
        return copy_state(&paths.shared);
    }
    let claude = paths.claude();
    if links_to(&claude, &paths.shared) {
        return EntryState::Linked;
    }
    if is_link(&claude) {
        return EntryState::Conflict;
    }
    copy_state(&claude)
}

/// Write Abundio's copy into `dir`, only touching files whose text differs.
fn write_copy(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    for (name, text) in [("SKILL.md", SKILL_MD), (MARKER, MARKER_TEXT)] {
        let path = dir.join(name);
        if fs::read_to_string(&path).ok().as_deref() != Some(text) {
            let tmp = dir.join(format!(".{name}.tmp"));
            fs::write(&tmp, text)?;
            fs::rename(&tmp, &path)?;
        }
    }
    Ok(())
}

/// Remove an entry Abundio owns: a link, or a marked copy.
fn remove_owned(path: &Path) -> io::Result<()> {
    if is_link(path) {
        // A directory symlink on Windows is removed as a directory.
        return fs::remove_file(path).or_else(|_| fs::remove_dir(path));
    }
    fs::remove_dir_all(path)
}

#[cfg(unix)]
fn make_dir_link(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn make_dir_link(target: &Path, link: &Path) -> io::Result<()> {
    // Needs Developer Mode or elevation; the caller falls back to a copy.
    std::os::windows::fs::symlink_dir(target, link)
}

/// Bring both locations in line with the settings. `enabled` is the skill
/// setting; `watched` are the Agents switched on. Per-location failures are
/// collected, not fatal, so a read-only Claude folder cannot stop the shared
/// copy.
pub fn provision_at(
    paths: &SkillPaths,
    enabled: bool,
    watched: &[String],
) -> Result<(), AbundioError> {
    let is_watched = |id: &str| watched.iter().any(|w| w == id);
    let want_shared = enabled && SHARED_READERS.iter().any(|a| is_watched(a));
    // No litter: Claude Code's folder is used only if it exists already.
    let want_claude = enabled && is_watched("claude") && paths.claude_home.is_dir();
    let mut errors: Vec<String> = Vec::new();

    // The shared copy first: the Claude link points at it.
    match copy_state(&paths.shared) {
        EntryState::Conflict => {
            if want_shared {
                errors.push(format!(
                    "{} exists and was not written by Abundio; left alone",
                    paths.shared.display()
                ));
            }
        }
        _ if want_shared => {
            if let Err(e) = write_copy(&paths.shared) {
                errors.push(format!("{}: {e}", paths.shared.display()));
            }
        }
        EntryState::Absent => {}
        _ => {
            if let Err(e) = remove_owned(&paths.shared) {
                errors.push(format!("{}: {e}", paths.shared.display()));
            }
        }
    }
    let shared_ours = copy_state(&paths.shared) == EntryState::Installed;

    let claude = paths.claude();
    let claude_state = entry_state(paths, "claude");
    if claude_state == EntryState::Conflict {
        if want_claude {
            errors.push(format!(
                "{} exists and was not written by Abundio; left alone",
                claude.display()
            ));
        }
    } else if want_claude {
        let result = (|| -> io::Result<()> {
            if shared_ours {
                if claude_state == EntryState::Linked {
                    return Ok(());
                }
                if claude_state != EntryState::Absent {
                    remove_owned(&claude)?;
                }
                fs::create_dir_all(claude.parent().expect("has a parent"))?;
                if make_dir_link(&paths.shared, &claude).is_ok() {
                    return Ok(());
                }
            } else if claude_state == EntryState::Linked {
                // Its target is gone: become a copy of its own.
                remove_owned(&claude)?;
            }
            write_copy(&claude)
        })();
        if let Err(e) = result {
            errors.push(format!("{}: {e}", claude.display()));
        }
    } else if claude_state != EntryState::Absent {
        if let Err(e) = remove_owned(&claude) {
            errors.push(format!("{}: {e}", claude.display()));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(AbundioError::Io(io::Error::other(errors.join("; "))))
    }
}

pub fn status_at(paths: &SkillPaths) -> Vec<SkillEntryStatus> {
    ["shared", "claude"]
        .into_iter()
        .map(|location| SkillEntryStatus {
            location,
            path: if location == "shared" {
                paths.shared.display().to_string()
            } else {
                paths.claude().display().to_string()
            },
            state: entry_state(paths, location),
        })
        .collect()
}

// ── Commands ──

fn blocking_err(e: impl std::fmt::Display) -> AbundioError {
    AbundioError::Io(io::Error::other(e.to_string()))
}

/// Re-sync the skill after a settings change.
#[tauri::command]
pub async fn agent_skill_provision(
    enabled: bool,
    enabled_agents: Vec<String>,
) -> Result<(), AbundioError> {
    tauri::async_runtime::spawn_blocking(move || {
        provision_at(&SkillPaths::for_user()?, enabled, &enabled_agents)
    })
    .await
    .map_err(blocking_err)?
}

/// At startup, once per process however many Windows ask: rewrite the skill
/// so an upgrade brings its new text.
#[tauri::command]
pub async fn agent_skill_provision_startup(
    enabled: bool,
    enabled_agents: Vec<String>,
    guard: tauri::State<'_, SkillStartupGuard>,
) -> Result<(), AbundioError> {
    if !guard.claim() {
        return Ok(());
    }
    eprintln!("[abundio] startup skill provisioning: enabled={enabled}");
    tauri::async_runtime::spawn_blocking(move || {
        let result = provision_at(&SkillPaths::for_user()?, enabled, &enabled_agents);
        if let Err(e) = &result {
            eprintln!("[abundio] startup skill provisioning: {e}");
        }
        result
    })
    .await
    .map_err(blocking_err)?
}

/// Where the skill is, for Settings.
#[tauri::command]
pub async fn agent_skill_status() -> Result<Vec<SkillEntryStatus>, AbundioError> {
    tauri::async_runtime::spawn_blocking(|| Ok(status_at(&SkillPaths::for_user()?)))
        .await
        .map_err(blocking_err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, SkillPaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = SkillPaths {
            shared: dir.path().join(".agents/skills/abundio"),
            claude_home: dir.path().join(".claude"),
        };
        (dir, paths)
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn writes_the_shared_copy_with_its_marker() {
        let (_d, p) = setup();
        provision_at(&p, true, &ids(&["codex"])).unwrap();
        assert_eq!(fs::read_to_string(p.shared.join("SKILL.md")).unwrap(), SKILL_MD);
        assert!(p.shared.join(MARKER).is_file());
        assert_eq!(status_at(&p)[0].state, EntryState::Installed);
    }

    #[test]
    fn skill_text_has_its_frontmatter_and_token_check() {
        assert!(SKILL_MD.starts_with("---\nname: abundio\n"));
        assert!(SKILL_MD.contains("ABUNDIO_AGENT_TOKEN"));
    }

    #[test]
    fn rewrites_a_changed_copy_and_leaves_an_equal_one_alone() {
        let (_d, p) = setup();
        provision_at(&p, true, &ids(&["codex"])).unwrap();
        let skill = p.shared.join("SKILL.md");
        fs::write(&skill, "old text").unwrap();
        assert_eq!(status_at(&p)[0].state, EntryState::Outdated);
        provision_at(&p, true, &ids(&["codex"])).unwrap();
        assert_eq!(fs::read_to_string(&skill).unwrap(), SKILL_MD);

        let before = fs::metadata(&skill).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        provision_at(&p, true, &ids(&["codex"])).unwrap();
        assert_eq!(fs::metadata(&skill).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn removes_the_shared_copy_when_off_or_nobody_reads_it() {
        let (_d, p) = setup();
        provision_at(&p, true, &ids(&["gemini"])).unwrap();
        provision_at(&p, false, &ids(&["gemini"])).unwrap();
        assert!(!p.shared.exists());

        provision_at(&p, true, &ids(&["gemini"])).unwrap();
        provision_at(&p, true, &ids(&[])).unwrap();
        assert!(!p.shared.exists());
    }

    #[test]
    fn never_touches_a_folder_abundio_did_not_write() {
        let (_d, p) = setup();
        fs::create_dir_all(&p.shared).unwrap();
        fs::write(p.shared.join("SKILL.md"), "the user's own").unwrap();
        assert!(provision_at(&p, true, &ids(&["codex"])).is_err());
        assert!(provision_at(&p, false, &ids(&[])).is_ok());
        assert_eq!(
            fs::read_to_string(p.shared.join("SKILL.md")).unwrap(),
            "the user's own"
        );
        assert_eq!(status_at(&p)[0].state, EntryState::Conflict);
    }

    #[test]
    fn creates_nothing_for_claude_without_its_config_folder() {
        let (_d, p) = setup();
        provision_at(&p, true, &ids(&["claude"])).unwrap();
        assert!(!p.claude_home.exists());
        assert!(!p.shared.exists(), "no shared reader is Watched");
    }

    #[cfg(unix)]
    #[test]
    fn links_claude_to_the_shared_copy() {
        let (_d, p) = setup();
        fs::create_dir_all(&p.claude_home).unwrap();
        provision_at(&p, true, &ids(&["claude", "codex"])).unwrap();
        assert!(links_to(&p.claude(), &p.shared));
        assert_eq!(status_at(&p)[1].state, EntryState::Linked);
        // Reading through the link gives the skill.
        assert_eq!(fs::read_to_string(p.claude().join("SKILL.md")).unwrap(), SKILL_MD);

        // Claude un-Watched: only its link goes.
        provision_at(&p, true, &ids(&["codex"])).unwrap();
        assert!(!exists_at_all(&p.claude()));
        assert!(p.shared.exists());
    }

    #[cfg(unix)]
    #[test]
    fn claude_alone_gets_a_copy_and_a_dangling_link_becomes_one() {
        let (_d, p) = setup();
        fs::create_dir_all(&p.claude_home).unwrap();
        provision_at(&p, true, &ids(&["claude"])).unwrap();
        assert_eq!(status_at(&p)[1].state, EntryState::Installed);
        assert!(!p.shared.exists());

        // Linked while Codex was Watched, then Codex goes: the shared copy is
        // removed and Claude's entry turns into a copy of its own.
        provision_at(&p, true, &ids(&["claude", "codex"])).unwrap();
        assert_eq!(status_at(&p)[1].state, EntryState::Linked);
        provision_at(&p, true, &ids(&["claude"])).unwrap();
        assert!(!p.shared.exists());
        assert_eq!(status_at(&p)[1].state, EntryState::Installed);

        provision_at(&p, false, &ids(&["claude"])).unwrap();
        assert!(!exists_at_all(&p.claude()));
        assert!(p.claude_home.is_dir(), "Claude's own folder stays");
    }

    #[cfg(unix)]
    #[test]
    fn leaves_a_foreign_claude_entry_alone() {
        let (d, p) = setup();
        fs::create_dir_all(p.claude_home.join("skills")).unwrap();
        let elsewhere = d.path().join("mine");
        fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, p.claude()).unwrap();
        assert!(provision_at(&p, true, &ids(&["claude"])).is_err());
        assert!(provision_at(&p, false, &ids(&[])).is_ok());
        assert!(links_to(&p.claude(), &elsewhere));
    }
}
