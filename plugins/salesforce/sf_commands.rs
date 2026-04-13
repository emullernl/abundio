// Placeholder for plugin-local Salesforce command implementations.
// Runtime command handlers are currently wired via src-tauri/src/commands.rs.
use std::process::Command;
use crate::error::AbundioError;

/// List available Salesforce orgs
#[tauri::command]
pub async fn sf_org_list() -> Result<Vec<SalesforceOrg>, AbundioError> {
    let output = run_sf_command(&["org:list", "--json"])?;
    let orgs: Vec<SalesforceOrg> = serde_json::from_str(&output)?;
    Ok(orgs)
}

/// Set default org
#[tauri::command]
pub async fn sf_set_default_org(org_id: String) -> Result<(), AbundioError> {
    run_sf_command(&["config:set", &format!("target-org={}", org_id)])?;
    Ok(())
}

/// Open org in browser
#[tauri::command]
pub async fn sf_open_org(org_id: String) -> Result<(), AbundioError> {
    run_sf_command(&["org:open", "--target-org", &org_id])?;
    Ok(())
}

/// Deploy to org
#[tauri::command]
pub async fn sf_deploy(source_path: String, org_id: String) -> Result<String, AbundioError> {
    let output = run_sf_command(&["project:deploy:start", "--source-dir", &source_path, "--target-org", &org_id, "--json"])?;
    Ok(output)
}

/// Helper to run sf command
fn run_sf_command(args: &[&str]) -> Result<String, AbundioError> {
    let output = Command::new("sf")
        .args(args)
        .output()
        .map_err(|e| AbundioError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, format!("sf command not found: {}", e))))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(AbundioError::Io(std::io::Error::new(std::io::ErrorKind::Other, String::from_utf8_lossy(&output.stderr))))
    }
}

/// Salesforce org structure
#[derive(serde::Deserialize, serde::Serialize, Debug)]
pub struct SalesforceOrg {
    pub org_id: String,
    pub username: String,
    pub alias: Option<String>,
    pub instance_url: String,
    pub is_default: bool,
}