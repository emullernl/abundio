use std::env;

/// Returns the user's default shell.
pub fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_non_empty_string() {
        let shell = default_shell();
        assert!(!shell.is_empty());
    }

    #[test]
    fn returns_a_valid_path() {
        let shell = default_shell();
        // On Unix, the shell should start with / or be a known command
        if !cfg!(target_os = "windows") {
            assert!(shell.starts_with('/') || shell == "cmd.exe");
        }
    }
}
