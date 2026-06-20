use std::env;
use std::path::Path;
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::OnceLock;

use serde::Serialize;

/// Windows process creation flag to suppress console window popups.
#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Returns the user's default shell.
/// On Windows, prefers Git Bash (bash.exe) for shell integration support.
pub fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        // Prefer Git Bash for shell integration (precmd/preexec hooks)
        for path in [
            "C:\\Program Files\\Git\\bin\\bash.exe",
            "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        ] {
            if std::path::Path::new(path).exists() {
                return path.to_string();
            }
        }
        // Check PATH for bash
        let mut cmd = std::process::Command::new("where");
        cmd.arg("bash.exe");
        // `#[cfg]` (not `cfg!()`) needed — `cfg!()` compiles both branches
        // but CommandExt::creation_flags doesn't exist on non-Windows
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(output) = cmd.output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !path.is_empty() {
                    // Win32 CreateProcess accepts backslashes natively;
                    // no slash conversion needed here (unlike --rcfile /
                    // ZDOTDIR which go through Git Bash's MSYS path layer)
                    return path;
                }
            }
        }
        // Fallback to cmd.exe (no shell integration)
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
///
/// The shell is invoked with `-l -i` (login + interactive) to match the flags
/// used when spawning terminal PTYs. Many tools (Claude Code's installer, etc.)
/// add themselves to PATH only from interactive-shell config (`.zshrc`), which
/// a login-but-not-interactive shell never sources — so without `-i` those
/// binaries resolve as "not installed" here even though they run fine inside a
/// pane. Interactive config may print to stdout (prompts, plugins), so the
/// PATH is wrapped in sentinels and extracted rather than parsing the whole
/// stream.
pub fn shell_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        if cfg!(target_os = "windows") {
            return env::var("PATH").unwrap_or_default();
        }

        let shell = default_shell();
        if let Ok(output) = Command::new(&shell)
            .args([
                "-l",
                "-i",
                "-c",
                "printf '__ABUNDIO_PATH_START__%s__ABUNDIO_PATH_END__' \"$PATH\"",
            ])
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(path) =
                    extract_between(&stdout, "__ABUNDIO_PATH_START__", "__ABUNDIO_PATH_END__")
                {
                    if !path.is_empty() {
                        return path.to_string();
                    }
                }
            }
        }

        // Fallback: current PATH + common Homebrew locations
        let current = env::var("PATH").unwrap_or_default();
        format!("{current}:/opt/homebrew/bin:/usr/local/bin")
    })
}

/// Returns the substring strictly between the first `start` marker and the
/// first following `end` marker, or `None` if either marker is absent.
fn extract_between<'a>(haystack: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let after_start = haystack.split_once(start)?.1;
    Some(after_start.split_once(end)?.0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableShell {
    pub name: String,
    pub path: String,
    pub available: bool,
    pub is_default: bool,
}

/// Returns a list of shells available on the system.
///
/// On Unix, reads `/etc/shells` and validates each path exists.
/// On Windows, checks for Git Bash and PowerShell.
pub fn list_available_shells() -> Vec<AvailableShell> {
    let default = default_shell();

    if cfg!(target_os = "windows") {
        list_available_shells_windows(&default)
    } else {
        list_available_shells_unix(&default)
    }
}

fn list_available_shells_unix(default: &str) -> Vec<AvailableShell> {
    let mut shells = Vec::new();
    let mut seen = std::collections::HashSet::new();

    if let Ok(contents) = std::fs::read_to_string("/etc/shells") {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if !seen.insert(line.to_string()) {
                continue;
            }
            let path = Path::new(line);
            let available = path.exists();
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(line)
                .to_string();
            shells.push(AvailableShell {
                name,
                path: line.to_string(),
                available,
                is_default: line == default,
            });
        }
    }

    shells
}

fn list_available_shells_windows(default: &str) -> Vec<AvailableShell> {
    let mut shells = Vec::new();

    // Git Bash
    let git_bash_path = find_git_bash();
    let git_bash_available = git_bash_path.is_some();
    shells.push(AvailableShell {
        name: "Git Bash".to_string(),
        path: git_bash_path.unwrap_or_else(|| "bash.exe".to_string()),
        available: git_bash_available,
        is_default: git_bash_available && default.contains("bash"),
    });

    // PowerShell 7 (pwsh)
    let pwsh_path = find_powershell("pwsh");
    let pwsh_available = pwsh_path.is_some();

    // Windows PowerShell 5.1 (powershell.exe)
    let ps5_path = find_powershell("powershell");
    let ps5_available = ps5_path.is_some();

    if pwsh_available {
        shells.push(AvailableShell {
            name: "PowerShell 7".to_string(),
            path: pwsh_path.unwrap(),
            available: true,
            is_default: !git_bash_available,
        });
    }
    if ps5_available {
        shells.push(AvailableShell {
            name: "Windows PowerShell".to_string(),
            path: ps5_path.unwrap(),
            available: true,
            is_default: !git_bash_available && !pwsh_available,
        });
    }

    // If neither pwsh nor powershell found, add a disabled entry
    if !pwsh_available && !ps5_available {
        shells.push(AvailableShell {
            name: "PowerShell".to_string(),
            path: "pwsh.exe".to_string(),
            available: false,
            is_default: false,
        });
    }

    shells
}

fn find_git_bash() -> Option<String> {
    for path in [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ] {
        if Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    // Check PATH
    where_command("bash.exe")
}

fn find_powershell(name: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let exe = format!("{name}.exe");
        where_command(&exe)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = name;
        None
    }
}

fn where_command(exe: &str) -> Option<String> {
    let mut cmd = Command::new(if cfg!(target_os = "windows") { "where" } else { "which" });
    cmd.arg(exe);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().ok()?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !path.is_empty() {
            return Some(path);
        }
    }
    None
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

    #[test]
    fn extract_between_pulls_path_out_of_noisy_stream() {
        // Interactive shell config can print to stdout before the PATH value;
        // the sentinels must isolate just the PATH regardless of that noise.
        let stream = "welcome banner\nplugin loaded\n__ABUNDIO_PATH_START__/usr/local/bin:/usr/bin__ABUNDIO_PATH_END__";
        assert_eq!(
            extract_between(stream, "__ABUNDIO_PATH_START__", "__ABUNDIO_PATH_END__"),
            Some("/usr/local/bin:/usr/bin")
        );
    }

    #[test]
    fn extract_between_returns_none_without_markers() {
        assert_eq!(extract_between("no markers here", "__START__", "__END__"), None);
        assert_eq!(
            extract_between("__START__only start", "__START__", "__END__"),
            None
        );
    }
}
