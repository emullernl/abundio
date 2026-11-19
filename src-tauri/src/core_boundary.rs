//! The **core** modules: everything a Host needs to run Workspaces with no
//! window (docs/plans/remote-hosts.md phase 6). They use no Tauri and reach
//! only each other, so they can move into the `abundio-core` crate and run
//! inside the headless `abundio-server`. This test keeps it that way: a core
//! module that starts using Tauri, or a desktop module, fails here.

/// Kept in step with `crates/abundio-core` once the move is made (6b).
pub const CORE: &[&str] = &[
    "agent_hooks", "agent_names", "app_paths", "change_hub", "config", "control_local",
    "control_protocol", "db_open", "env_crypto", "env_vars", "error", "event_sink", "events",
    "file_watcher", "git_core", "git_libgit2", "git_scheduler", "hook_server", "layout_ops",
    "layout_store", "migrations", "owner_map", "pane_facts", "process_monitor", "profile_store",
    "pty_manager", "screen", "shell_env", "status_machine", "status_store", "workspace_store",
    "worktree_watcher",
];

#[cfg(test)]
mod tests {
    use super::CORE;

    /// A module's code, without its comments and its tests.
    fn code(module: &str) -> String {
        let path = format!("{}/src/{module}.rs", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let text = match text.find("\n#[cfg(test)]\nmod tests") {
            Some(i) => &text[..i],
            None => &text,
        };
        text.lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn core_modules_use_no_tauri() {
        for m in CORE {
            let c = code(m);
            for word in ["tauri", "AppHandle", "rfd::"] {
                assert!(!c.contains(word), "core module {m} uses {word}");
            }
        }
    }

    #[test]
    fn core_modules_reach_only_each_other() {
        for m in CORE {
            let c = code(m);
            for (i, _) in c.match_indices("crate::") {
                let name: String = c[i + 7..]
                    .chars()
                    .take_while(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || *ch == '_')
                    .collect();
                assert!(
                    CORE.contains(&name.as_str()),
                    "core module {m} uses crate::{name}, which is not core"
                );
            }
        }
    }
}
