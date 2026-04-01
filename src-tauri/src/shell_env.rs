use std::env;
use std::process::Command;
use std::sync::OnceLock;

/// Returns the user's default shell.
pub fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

/// Returns the user's full login shell PATH.
///
/// On macOS, apps launched from Finder inherit a minimal PATH that doesn't
/// include Homebrew directories. This resolves the real PATH by invoking the
/// user's login shell once, then caches the result for the process lifetime.
pub fn shell_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        if cfg!(target_os = "windows") {
            return env::var("PATH").unwrap_or_default();
        }

        let shell = default_shell();
        if let Ok(output) = Command::new(&shell)
            .args(["-l", "-c", "echo $PATH"])
            .output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return path;
                }
            }
        }

        // Fallback: current PATH + common Homebrew locations
        let current = env::var("PATH").unwrap_or_default();
        format!("{current}:/opt/homebrew/bin:/usr/local/bin")
    })
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
