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

/// Claims the one-time right to seed the per-Agent **Watched** toggles from
/// what is **Installed**. `true` means this caller should seed; `false` means
/// somebody already has (or this is an upgrade, where startup spends the claim
/// unseeded). See ADR-0037.
///
/// The frontend must call this only *after* a `$PATH` scan has found at least
/// one installed Agent — an empty scan is far likelier to be a shell that
/// timed out than a machine with no coding CLIs, and spending the claim on it
/// would leave the toggles unseeded forever.
#[tauri::command]
pub async fn agents_claim_seeding(
    store: State<'_, WorkspaceStore>,
) -> Result<bool, AbundioError> {
    store.claim_agent_seeding()
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
