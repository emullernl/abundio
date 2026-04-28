use crate::dev_environments::find_in_path;

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
