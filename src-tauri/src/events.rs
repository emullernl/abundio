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
