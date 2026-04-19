//! Desktop dev-environment integration: detection + launch for VSCode, Cursor,
//! JetBrains IDEs, and friends. Pure Rust — no app state, no DB.

use crate::error::AbundioError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchStyle {
    /// VSCode-family CLIs: `<cli> <folder> --goto <file>:<line>:<col>`.
    VSCodeLike,
    /// Zed / Sublime: `<cli> <folder> <file>:<line>:<col>`.
    PositionalColon,
    /// JetBrains CLIs: `<cli> --line N --column M <folder> <file>`.
    JetBrains,
    /// Xcode's `xed`: `xed -l <line> <file>` (no column, no folder).
    Xed,
}

pub struct DevEnvironmentDef {
    pub id: &'static str,
    pub display_name: &'static str,
    pub icon_name: &'static str,
    pub mac_app_names: &'static [&'static str],
    pub cli_names: &'static [&'static str],
    pub launch_style: LaunchStyle,
}

pub const BUILTIN_DEV_ENVIRONMENTS: &[DevEnvironmentDef] = &[
    DevEnvironmentDef {
        id: "vscode",
        display_name: "VS Code",
        icon_name: "vscode",
        mac_app_names: &["Visual Studio Code"],
        cli_names: &["code"],
        launch_style: LaunchStyle::VSCodeLike,
    },
    DevEnvironmentDef {
        id: "vscode-insiders",
        display_name: "VS Code Insiders",
        icon_name: "vscode-insiders",
        mac_app_names: &["Visual Studio Code - Insiders"],
        cli_names: &["code-insiders"],
        launch_style: LaunchStyle::VSCodeLike,
    },
    DevEnvironmentDef {
        id: "cursor",
        display_name: "Cursor",
        icon_name: "cursor",
        mac_app_names: &["Cursor"],
        cli_names: &["cursor"],
        launch_style: LaunchStyle::VSCodeLike,
    },
    DevEnvironmentDef {
        id: "windsurf",
        display_name: "Windsurf",
        icon_name: "windsurf",
        mac_app_names: &["Windsurf"],
        cli_names: &["windsurf"],
        launch_style: LaunchStyle::VSCodeLike,
    },
    DevEnvironmentDef {
        id: "zed",
        display_name: "Zed",
        icon_name: "zed",
        mac_app_names: &["Zed"],
        cli_names: &["zed"],
        launch_style: LaunchStyle::PositionalColon,
    },
    DevEnvironmentDef {
        id: "sublime",
        display_name: "Sublime Text",
        icon_name: "sublime",
        mac_app_names: &["Sublime Text"],
        cli_names: &["subl"],
        launch_style: LaunchStyle::PositionalColon,
    },
    DevEnvironmentDef {
        id: "xcode",
        display_name: "Xcode",
        icon_name: "xcode",
        mac_app_names: &["Xcode"],
        cli_names: &["xed"],
        launch_style: LaunchStyle::Xed,
    },
    DevEnvironmentDef {
        id: "intellij",
        display_name: "IntelliJ IDEA",
        icon_name: "jetbrains",
        mac_app_names: &["IntelliJ IDEA", "IntelliJ IDEA CE", "IntelliJ IDEA Community Edition"],
        cli_names: &["idea"],
        launch_style: LaunchStyle::JetBrains,
    },
    DevEnvironmentDef {
        id: "webstorm",
        display_name: "WebStorm",
        icon_name: "jetbrains",
        mac_app_names: &["WebStorm"],
        cli_names: &["webstorm"],
        launch_style: LaunchStyle::JetBrains,
    },
    DevEnvironmentDef {
        id: "pycharm",
        display_name: "PyCharm",
        icon_name: "jetbrains",
        mac_app_names: &["PyCharm", "PyCharm Professional Edition", "PyCharm CE", "PyCharm Community Edition"],
        cli_names: &["pycharm"],
        launch_style: LaunchStyle::JetBrains,
    },
    DevEnvironmentDef {
        id: "phpstorm",
        display_name: "PhpStorm",
        icon_name: "jetbrains",
        mac_app_names: &["PhpStorm"],
        cli_names: &["phpstorm"],
        launch_style: LaunchStyle::JetBrains,
    },
    DevEnvironmentDef {
        id: "goland",
        display_name: "GoLand",
        icon_name: "jetbrains",
        mac_app_names: &["GoLand"],
        cli_names: &["goland"],
        launch_style: LaunchStyle::JetBrains,
    },
    DevEnvironmentDef {
        id: "clion",
        display_name: "CLion",
        icon_name: "jetbrains",
        mac_app_names: &["CLion"],
        cli_names: &["clion"],
        launch_style: LaunchStyle::JetBrains,
    },
    DevEnvironmentDef {
        id: "rubymine",
        display_name: "RubyMine",
        icon_name: "jetbrains",
        mac_app_names: &["RubyMine"],
        cli_names: &["rubymine"],
        launch_style: LaunchStyle::JetBrains,
    },
    DevEnvironmentDef {
        id: "rider",
        display_name: "Rider",
        icon_name: "jetbrains",
        mac_app_names: &["Rider"],
        cli_names: &["rider"],
        launch_style: LaunchStyle::JetBrains,
    },
    DevEnvironmentDef {
        id: "rustrover",
        display_name: "RustRover",
        icon_name: "jetbrains",
        mac_app_names: &["RustRover"],
        cli_names: &["rustrover"],
        launch_style: LaunchStyle::JetBrains,
    },
    DevEnvironmentDef {
        id: "datagrip",
        display_name: "DataGrip",
        icon_name: "jetbrains",
        mac_app_names: &["DataGrip"],
        cli_names: &["datagrip"],
        launch_style: LaunchStyle::JetBrains,
    },
    DevEnvironmentDef {
        id: "android-studio",
        display_name: "Android Studio",
        icon_name: "jetbrains",
        mac_app_names: &["Android Studio"],
        cli_names: &["studio"],
        launch_style: LaunchStyle::JetBrains,
    },
];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectedDevEnvironment {
    pub id: String,
    pub display_name: String,
    pub icon_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchFile {
    pub path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

/// Probe `$PATH` for an executable. On Windows, also probes common binary extensions.
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(target_os = "windows")]
        {
            for ext in ["exe", "cmd", "bat"] {
                let candidate_ext = dir.join(format!("{}.{}", name, ext));
                if candidate_ext.is_file() {
                    return Some(candidate_ext);
                }
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn find_mac_app(name: &str) -> Option<PathBuf> {
    let global = PathBuf::from(format!("/Applications/{}.app", name));
    if global.is_dir() {
        return Some(global);
    }
    if let Some(home) = dirs::home_dir() {
        let user_app = home.join(format!("Applications/{}.app", name));
        if user_app.is_dir() {
            return Some(user_app);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn find_mac_app(_name: &str) -> Option<PathBuf> {
    None
}

pub fn detect_all() -> Vec<DetectedDevEnvironment> {
    let mut results = Vec::new();
    for def in BUILTIN_DEV_ENVIRONMENTS {
        let has_cli = def.cli_names.iter().any(|c| find_in_path(c).is_some());
        let has_app = def.mac_app_names.iter().any(|n| find_mac_app(n).is_some());
        if has_cli || has_app {
            results.push(DetectedDevEnvironment {
                id: def.id.to_string(),
                display_name: def.display_name.to_string(),
                icon_name: def.icon_name.to_string(),
            });
        }
    }
    results
}

fn goto_target(f: &LaunchFile) -> String {
    match (f.line, f.column) {
        (Some(line), Some(col)) => format!("{}:{}:{}", f.path, line, col),
        (Some(line), None) => format!("{}:{}", f.path, line),
        _ => f.path.clone(),
    }
}

/// Build the CLI args for a launch. Pure function so it's unit-testable without
/// spawning a real process.
pub fn build_cli_args(
    style: LaunchStyle,
    workspace_folder: &str,
    file: Option<&LaunchFile>,
) -> Vec<String> {
    match style {
        // VSCode / Cursor / Windsurf and Zed / Sublime share the same arg shape:
        // `<cli> <folder> <file>:<line>:<col>`. We intentionally do NOT use
        // `--goto` for VSCode-family CLIs — when a different folder's window is
        // currently focused, `--goto` routes the file there and ignores the
        // folder arg. Plain positional args make VSCode open (or focus) the
        // specified folder as the workspace and open the file in that window.
        LaunchStyle::VSCodeLike | LaunchStyle::PositionalColon => {
            let mut args = vec![workspace_folder.to_string()];
            if let Some(f) = file {
                args.push(goto_target(f));
            }
            args
        }
        LaunchStyle::JetBrains => {
            let mut args = Vec::new();
            if let Some(f) = file {
                if let Some(line) = f.line {
                    args.push("--line".into());
                    args.push(line.to_string());
                }
                if let Some(col) = f.column {
                    args.push("--column".into());
                    args.push(col.to_string());
                }
            }
            args.push(workspace_folder.to_string());
            if let Some(f) = file {
                args.push(f.path.clone());
            }
            args
        }
        LaunchStyle::Xed => {
            let mut args = Vec::new();
            if let Some(f) = file {
                if let Some(line) = f.line {
                    args.push("-l".into());
                    args.push(line.to_string());
                }
                args.push(f.path.clone());
            } else {
                args.push(workspace_folder.to_string());
            }
            args
        }
    }
}

pub fn launch(
    id: &str,
    workspace_folder: &str,
    file: Option<&LaunchFile>,
) -> Result<(), AbundioError> {
    let def = BUILTIN_DEV_ENVIRONMENTS
        .iter()
        .find(|d| d.id == id)
        .ok_or_else(|| AbundioError::NotFound(format!("dev environment '{}'", id)))?;

    for cli in def.cli_names {
        if let Some(bin) = find_in_path(cli) {
            let args = build_cli_args(def.launch_style, workspace_folder, file);
            Command::new(bin)
                .args(&args)
                .spawn()
                .map_err(AbundioError::Io)?;
            return Ok(());
        }
    }

    #[cfg(target_os = "macos")]
    {
        for name in def.mac_app_names {
            if find_mac_app(name).is_some() {
                let mut cmd = Command::new("open");
                cmd.arg("-a").arg(name);
                // `open -a` can only accept one path arg reliably. Prefer the file
                // if we have one (the folder will usually already be in the editor's
                // MRU); otherwise open the folder itself.
                match file {
                    Some(f) => {
                        cmd.arg(&f.path);
                    }
                    None => {
                        cmd.arg(workspace_folder);
                    }
                }
                cmd.spawn().map_err(AbundioError::Io)?;
                return Ok(());
            }
        }
    }

    Err(AbundioError::NotFound(format!(
        "no launcher available for '{}'",
        id
    )))
}

#[tauri::command]
pub fn list_dev_environments() -> Vec<DetectedDevEnvironment> {
    detect_all()
}

#[tauri::command]
pub fn launch_dev_environment(
    id: String,
    workspace_folder: String,
    file: Option<LaunchFile>,
) -> Result<(), AbundioError> {
    launch(&id, &workspace_folder, file.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lf(path: &str, line: Option<u32>, column: Option<u32>) -> LaunchFile {
        LaunchFile {
            path: path.into(),
            line,
            column,
        }
    }

    #[test]
    fn vscode_folder_only() {
        let args = build_cli_args(LaunchStyle::VSCodeLike, "/ws", None);
        assert_eq!(args, vec!["/ws"]);
    }

    #[test]
    fn vscode_with_file_no_line() {
        let file = lf("/ws/a.rs", None, None);
        let args = build_cli_args(LaunchStyle::VSCodeLike, "/ws", Some(&file));
        // Folder must come before the file so VSCode opens folder as workspace.
        // No `--goto` — it causes VSCode to route the file to whatever window
        // is currently focused, ignoring our folder arg.
        assert_eq!(args, vec!["/ws", "/ws/a.rs"]);
    }

    #[test]
    fn vscode_with_file_line_and_col() {
        let file = lf("/ws/a.rs", Some(12), Some(4));
        let args = build_cli_args(LaunchStyle::VSCodeLike, "/ws", Some(&file));
        assert_eq!(args, vec!["/ws", "/ws/a.rs:12:4"]);
    }

    #[test]
    fn vscode_with_file_line_only() {
        let file = lf("/ws/a.rs", Some(7), None);
        let args = build_cli_args(LaunchStyle::VSCodeLike, "/ws", Some(&file));
        assert_eq!(args, vec!["/ws", "/ws/a.rs:7"]);
    }

    #[test]
    fn positional_colon_folder_only() {
        let args = build_cli_args(LaunchStyle::PositionalColon, "/ws", None);
        assert_eq!(args, vec!["/ws"]);
    }

    #[test]
    fn positional_colon_with_file() {
        let file = lf("/ws/b.py", Some(3), Some(8));
        let args = build_cli_args(LaunchStyle::PositionalColon, "/ws", Some(&file));
        assert_eq!(args, vec!["/ws", "/ws/b.py:3:8"]);
    }

    #[test]
    fn jetbrains_folder_only() {
        let args = build_cli_args(LaunchStyle::JetBrains, "/ws", None);
        assert_eq!(args, vec!["/ws"]);
    }

    #[test]
    fn jetbrains_with_file_and_line() {
        let file = lf("/ws/m.kt", Some(22), Some(5));
        let args = build_cli_args(LaunchStyle::JetBrains, "/ws", Some(&file));
        assert_eq!(
            args,
            vec!["--line", "22", "--column", "5", "/ws", "/ws/m.kt"]
        );
    }

    #[test]
    fn jetbrains_with_file_no_line() {
        let file = lf("/ws/m.kt", None, None);
        let args = build_cli_args(LaunchStyle::JetBrains, "/ws", Some(&file));
        assert_eq!(args, vec!["/ws", "/ws/m.kt"]);
    }

    #[test]
    fn xed_folder_only() {
        let args = build_cli_args(LaunchStyle::Xed, "/ws", None);
        assert_eq!(args, vec!["/ws"]);
    }

    #[test]
    fn xed_with_file_and_line() {
        let file = lf("/ws/app.swift", Some(40), Some(12));
        let args = build_cli_args(LaunchStyle::Xed, "/ws", Some(&file));
        assert_eq!(args, vec!["-l", "40", "/ws/app.swift"]);
    }

    #[test]
    fn launch_unknown_id_returns_not_found() {
        let err = launch("does-not-exist", "/ws", None).unwrap_err();
        assert!(matches!(err, AbundioError::NotFound(_)));
    }

    #[test]
    fn detect_all_does_not_panic() {
        let _ = detect_all();
    }

    #[test]
    fn all_builtin_ids_are_unique() {
        let mut ids: Vec<&str> = BUILTIN_DEV_ENVIRONMENTS.iter().map(|d| d.id).collect();
        ids.sort();
        let original_len = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), original_len);
    }
}
