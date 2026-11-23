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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_values() {
        let config = AppConfig::default();
        assert_eq!(config.font_family, "JetBrains Mono");
        assert_eq!(config.font_size, 14);
        assert_eq!(config.theme, "default");
    }

    #[test]
    fn serde_round_trip() {
        let config = AppConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.font_family, config.font_family);
        assert_eq!(deserialized.font_size, config.font_size);
        assert_eq!(deserialized.theme, config.theme);
    }

    #[test]
    fn camel_case_json_keys() {
        let config = AppConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("fontFamily"));
        assert!(json.contains("fontSize"));
        assert!(!json.contains("font_family"));
        assert!(!json.contains("font_size"));
    }
}
