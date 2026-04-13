use serde::{Deserialize, Serialize};
use std::fs;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Plugin manifest structure loaded from plugins/*/manifest.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub description: String,
    pub commands: Vec<String>, // List of command names exposed by the plugin
    pub ui: Option<PluginUI>,  // Optional UI configuration
}

/// UI configuration for plugins
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginUI {
    pub panel: Option<String>, // Path to React component file relative to plugin dir, e.g. "SalesforcePanel.tsx"
}

/// Loaded plugin with its directory path
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plugin {
    pub id: String, // Directory name, e.g. "salesforce"
    pub dir: String, // Absolute path to plugin directory
    pub manifest: PluginManifest,
}

/// Load all plugins from the plugins/ directory
pub fn load_plugins(plugins_dir: &Path) -> Result<Vec<Plugin>, Box<dyn std::error::Error>> {
    let mut plugins = Vec::new();

    if !plugins_dir.exists() {
        return Ok(plugins);
    }

    for entry in fs::read_dir(plugins_dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            if let Some(dir_name) = path.file_name().and_then(|n| n.to_str()) {
                let manifest_path = path.join("manifest.json");
                if manifest_path.exists() {
                    match load_plugin_manifest(&manifest_path) {
                        Ok(manifest) => {
                            plugins.push(Plugin {
                                id: dir_name.to_string(),
                                dir: path.to_string_lossy().to_string(),
                                manifest,
                            });
                        }
                        Err(e) => {
                            eprintln!("Failed to load plugin {}: {}", dir_name, e);
                        }
                    }
                }
            }
        }
    }

    Ok(plugins)
}

/// Load a single plugin manifest from JSON file
fn load_plugin_manifest(path: &Path) -> Result<PluginManifest, Box<dyn std::error::Error>> {
    let content = fs::read_to_string(path)?;
    let content = content.trim_start_matches('\u{feff}');
    let manifest: PluginManifest = serde_json::from_str(content)?;
    Ok(manifest)
}

/// Validate plugin manifest (basic checks)
pub fn validate_plugin(manifest: &PluginManifest) -> Result<(), String> {
    if manifest.name.is_empty() {
        return Err("Plugin name cannot be empty".to_string());
    }
    if manifest.version.is_empty() {
        return Err("Plugin version cannot be empty".to_string());
    }
    // Add more validation as needed
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_load_plugins() {
        let temp_dir = TempDir::new().unwrap();
        let plugins_dir = temp_dir.path();

        // Create a test plugin
        let plugin_dir = plugins_dir.join("testplugin");
        fs::create_dir(&plugin_dir).unwrap();
        let manifest = r#"{
            "name": "Test Plugin",
            "version": "1.0.0",
            "description": "A test plugin",
            "commands": ["test_cmd"],
            "ui": {"panel": "TestPanel.tsx"}
        }"#;
        fs::write(plugin_dir.join("manifest.json"), manifest).unwrap();

        let plugins = load_plugins(plugins_dir).unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "testplugin");
        assert_eq!(plugins[0].manifest.name, "Test Plugin");
    }

    #[test]
    fn test_validate_plugin() {
        let manifest = PluginManifest {
            name: "Valid Plugin".to_string(),
            version: "1.0.0".to_string(),
            description: "Test".to_string(),
            commands: vec!["cmd".to_string()],
            ui: None,
        };
        assert!(validate_plugin(&manifest).is_ok());

        let invalid = PluginManifest {
            name: "".to_string(),
            version: "1.0.0".to_string(),
            description: "Test".to_string(),
            commands: vec![],
            ui: None,
        };
        assert!(validate_plugin(&invalid).is_err());
    }
}

/// Load plugins from multiple directories, de-duplicating by plugin id.
/// First match wins, allowing user-installed plugins to override bundled ones.
pub fn load_plugins_from_dirs(
    plugin_dirs: &[PathBuf],
) -> Result<Vec<Plugin>, Box<dyn std::error::Error>> {
    let mut all = Vec::new();
    let mut seen_ids = HashSet::new();

    for dir in plugin_dirs {
        let loaded = load_plugins(dir)?;
        for plugin in loaded {
            if seen_ids.insert(plugin.id.clone()) {
                all.push(plugin);
            }
        }
    }

    Ok(all)
}

/// Returns the writable user plugin directory and creates it if missing.
pub fn ensure_user_plugins_dir() -> Result<PathBuf, std::io::Error> {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("abundio").join("plugins");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Resolve plugin directories in priority order.
/// Plugins are loaded from the user data/config directory only.
pub fn resolve_plugin_dirs() -> Vec<PathBuf> {
    match ensure_user_plugins_dir() {
        Ok(user_dir) => vec![user_dir],
        Err(_) => Vec::new(),
    }
}