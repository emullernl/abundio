use std::sync::atomic::{AtomicBool, Ordering};

use tauri::State;

use crate::dev_environments::find_in_path;
use crate::error::AbundioError;
use crate::workspace_store::WorkspaceStore;

/// Returns the subset of `commands` whose binary is found on `$PATH`
/// (plus `/usr/local/bin` and `/opt/homebrew/bin` on macOS).
/// Pure filesystem check — no subprocesses spawned.
#[tauri::command]
pub fn list_installed_agent_commands(commands: Vec<String>) -> Vec<String> {
    commands
        .into_iter()
        .filter(|cmd| find_in_path(cmd).is_some())
        .collect()
}

/// True when agent scans use the user's real login-shell `$PATH`, false when
/// resolving it failed or timed out and scans run on the minimal fallback.
/// Resolves the path first if nothing has yet, which can block for up to the
/// shell timeout, so it is a sync command: Tauri runs those off the async
/// runtime, where a blocking wait cannot park a Tokio worker.
#[tauri::command]
pub fn agents_path_is_resolved() -> bool {
    crate::shell_env::shell_path_is_resolved()
}

/// Set once a Window has taken the claim in this process, so a second Window
/// cannot seed concurrently. Process-local on purpose: a Tauri app is one
/// process, so this covers every Window, and unlike a database write it leaves
/// nothing behind if the seed never completes.
static SEEDING_CLAIMED_THIS_LAUNCH: AtomicBool = AtomicBool::new(false);

/// Claims the one-time right to seed the per-Agent **Watched** toggles from
/// what is **Installed**. `true` means this caller should seed, and must then
/// call [`agents_commit_seeding`]. See ADR-0037.
///
/// The claim is deliberately **not** written to the database here. Committing
/// it up front spends it even when the seed never lands — an exception on the
/// way, or a quit before zustand persists `abundio-settings` — and no later
/// launch would retry. So the claim is split: mutual exclusion between Windows
/// comes from a process-local flag, durability comes from
/// [`agents_commit_seeding`] after the toggles are actually set.
///
/// Callers must scan `$PATH` first and claim only once the scan has found
/// something. An empty scan is read as a failed scan, never as a machine with
/// no Agents.
#[tauri::command]
pub async fn agents_claim_seeding(
    store: State<'_, WorkspaceStore>,
) -> Result<bool, AbundioError> {
    if store.agent_seeding_is_done()? {
        return Ok(false);
    }
    // `swap` rather than load-then-store: two Windows can reach this at once.
    Ok(!SEEDING_CLAIMED_THIS_LAUNCH.swap(true, Ordering::SeqCst))
}

/// Spends the claim, now that a seed has actually been applied. Idempotent.
#[tauri::command]
pub async fn agents_commit_seeding(
    store: State<'_, WorkspaceStore>,
) -> Result<(), AbundioError> {
    store.mark_agent_seeding_done()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(list_installed_agent_commands(vec![]), Vec::<String>::new());
    }

    #[test]
    fn nonexistent_command_not_returned() {
        let result = list_installed_agent_commands(vec![
            "__abundio_agent_that_does_not_exist__".into(),
        ]);
        assert!(result.is_empty());
    }
}
