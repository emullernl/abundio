use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub name: String,
    pub binary: String,
    pub display_name: String,
    pub icon: String,
    pub default_args: Vec<String>,
    pub available: bool,
}

struct AgentDef {
    name: &'static str,
    binary: &'static str,
    display_name: &'static str,
    icon: &'static str,
    default_args: &'static [&'static str],
}

const KNOWN_AGENTS: &[AgentDef] = &[
    AgentDef {
        name: "claude-code",
        binary: "claude",
        display_name: "Claude Code",
        icon: "claude",
        default_args: &[],
    },
    AgentDef {
        name: "gh-copilot",
        binary: "gh",
        display_name: "GitHub Copilot CLI",
        icon: "copilot",
        default_args: &["copilot"],
    },
    AgentDef {
        name: "gemini-cli",
        binary: "gemini",
        display_name: "Gemini CLI",
        icon: "gemini",
        default_args: &[],
    },
    AgentDef {
        name: "aider",
        binary: "aider",
        display_name: "Aider",
        icon: "aider",
        default_args: &[],
    },
    AgentDef {
        name: "codex",
        binary: "codex",
        display_name: "Codex CLI",
        icon: "codex",
        default_args: &[],
    },
    AgentDef {
        name: "opencode",
        binary: "opencode",
        display_name: "OpenCode",
        icon: "opencode",
        default_args: &[],
    },
];

fn path_separator() -> char {
    if cfg!(target_os = "windows") {
        ';'
    } else {
        ':'
    }
}

fn scan_agents() -> Vec<AgentInfo> {
    let path_dirs: Vec<PathBuf> = std::env::var("PATH")
        .unwrap_or_default()
        .split(path_separator())
        .map(PathBuf::from)
        .collect();

    KNOWN_AGENTS
        .iter()
        .map(|def| {
            let available = path_dirs.iter().any(|dir| {
                let candidate = dir.join(def.binary);
                candidate.exists()
            });

            AgentInfo {
                name: def.name.to_string(),
                binary: def.binary.to_string(),
                display_name: def.display_name.to_string(),
                icon: def.icon.to_string(),
                default_args: def.default_args.iter().map(|s| s.to_string()).collect(),
                available,
            }
        })
        .collect()
}

pub struct AgentRegistry {
    agents: Mutex<Vec<AgentInfo>>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self {
            agents: Mutex::new(scan_agents()),
        }
    }

    pub fn list(&self) -> Vec<AgentInfo> {
        self.agents.lock().unwrap().clone()
    }

    pub fn refresh(&self) {
        let mut agents = self.agents.lock().unwrap();
        *agents = scan_agents();
    }

    pub fn get(&self, name: &str) -> Option<AgentInfo> {
        self.agents
            .lock()
            .unwrap()
            .iter()
            .find(|a| a.name == name)
            .cloned()
    }
}
