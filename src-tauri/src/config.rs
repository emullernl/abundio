use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub font_family: String,
    pub font_size: u16,
    pub theme: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            font_family: "JetBrains Mono".to_string(),
            font_size: 14,
            theme: "default".to_string(),
        }
    }
}
