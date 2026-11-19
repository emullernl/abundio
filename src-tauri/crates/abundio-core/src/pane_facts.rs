//! What the Window knows about each pane that Rust does not see yet: its
//! terminal title, its live folder, the command running in it, the Agent
//! detected in it, its **Progress line**, and whether shell integration
//! reported in (docs/plans/remote-hosts.md phase 5). The Window reports
//! them as they change (`pane_facts_report`), so Agent control can describe
//! a pane in Rust. Their sources (title and OSC 7770 parsing, Agent signals)
//! move into Rust with the server (phase 6), and this mirror goes away.

use dashmap::DashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneFacts {
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub command: Option<String>,
    pub detected_agent_id: Option<String>,
    pub progress: Option<String>,
    #[serde(default)]
    pub shell_integration_seen: bool,
}

/// One pane's facts, or `None` when the pane is gone.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneFactsReport {
    pub pane_id: String,
    pub facts: Option<PaneFacts>,
}

#[derive(Default)]
pub struct PaneFactsStore {
    by_pane: DashMap<String, PaneFacts>,
}

impl PaneFactsStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn apply(&self, reports: Vec<PaneFactsReport>) {
        for r in reports {
            match r.facts {
                Some(f) => {
                    self.by_pane.insert(r.pane_id, f);
                }
                None => {
                    self.by_pane.remove(&r.pane_id);
                }
            }
        }
    }

    /// A pane's facts; all empty when the Window has reported none.
    pub fn get(&self, pane_id: &str) -> PaneFacts {
        self.by_pane.get(pane_id).map(|f| f.clone()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_latest_report_and_forgets_a_gone_pane() {
        let store = PaneFactsStore::new();
        let facts = |title: &str| PaneFacts { title: Some(title.into()), ..Default::default() };
        store.apply(vec![
            PaneFactsReport { pane_id: "a".into(), facts: Some(facts("one")) },
            PaneFactsReport { pane_id: "a".into(), facts: Some(facts("two")) },
        ]);
        assert_eq!(store.get("a").title.as_deref(), Some("two"));
        store.apply(vec![PaneFactsReport { pane_id: "a".into(), facts: None }]);
        assert_eq!(store.get("a"), PaneFacts::default());
    }

    #[test]
    fn reads_the_windows_report() {
        let r: Vec<PaneFactsReport> = serde_json::from_str(
            r#"[{"paneId":"a","facts":{"title":"t","cwd":"/x","command":null,"detectedAgentId":"claude","progress":null,"shellIntegrationSeen":true}},{"paneId":"b","facts":null}]"#,
        )
        .unwrap();
        assert_eq!(r[0].facts.as_ref().unwrap().detected_agent_id.as_deref(), Some("claude"));
        assert!(r[1].facts.is_none());
    }
}
