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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PtyActivity {
    CommandStarted,
    CommandFinished,
    ForegroundProcess { name: String },
    ForegroundProcessExited,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    pub root: String,
    pub paths: Vec<String>,
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

    #[test]
    fn pty_activity_foreground_process_serialization() {
        let activity = PtyActivity::ForegroundProcess { name: "claude".to_string() };
        let json = serde_json::to_string(&activity).unwrap();
        assert_eq!(json, r#"{"type":"foregroundProcess","name":"claude"}"#);
    }

    #[test]
    fn pty_activity_foreground_process_exited_serialization() {
        let activity = PtyActivity::ForegroundProcessExited;
        let json = serde_json::to_string(&activity).unwrap();
        assert_eq!(json, r#"{"type":"foregroundProcessExited"}"#);
    }
}
