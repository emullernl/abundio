use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutput {
    pub data: String, // base64-encoded bytes
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PtyStatus {
    Running,
    Exited { code: Option<u32> },
    ShellNotFound {
        configured: String,
        fallback: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PtyActivity {
    CommandStarted,
    CommandFinished,
}

/// A lifecycle hook event emitted by an Agent (Claude Code, Copilot, etc.),
/// relayed into Abundio via the loopback hook server. Drives the status
/// indicator. `payload` is the raw JSON the agent sent on the hook's stdin.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookEvent {
    pub agent: String,
    pub event: String,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    pub root: String,
    pub paths: Vec<String>,
    pub changed_files: Vec<String>,
    pub removed_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub root: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_output_serialization() {
        let output = PtyOutput { data: "abc".to_string() };
        let json = serde_json::to_string(&output).unwrap();
        assert_eq!(json, r#"{"data":"abc"}"#);
    }

    #[test]
    fn pty_status_running_serialization() {
        let status = PtyStatus::Running;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, r#"{"type":"running"}"#);
    }

    #[test]
    fn pty_status_exited_with_code() {
        let status = PtyStatus::Exited { code: Some(0) };
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, r#"{"type":"exited","code":0}"#);
    }

    #[test]
    fn pty_status_exited_without_code() {
        let status = PtyStatus::Exited { code: None };
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, r#"{"type":"exited","code":null}"#);
    }

}
