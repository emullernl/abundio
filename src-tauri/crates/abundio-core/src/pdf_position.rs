//! Where a PDF view is: its page and zoom, remembered for a File window and
//! an Orchestrator tab (docs/plans/pdf-viewer.md). A File pane keeps its own
//! on the layout node. The frontend's `lib/pdfView.ts` has the same rules.

use serde::{Deserialize, Serialize};

use crate::error::AbundioError;

pub const MIN_SCALE: f64 = 0.25;
pub const MAX_SCALE: f64 = 5.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PdfZoom {
    Preset(PdfZoomPreset),
    Scale(f64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfZoomPreset {
    PageWidth,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PdfPosition {
    pub page: u32,
    pub zoom: PdfZoom,
}

impl PdfPosition {
    /// Refuses a page below 1 and a scale out of range, so only positions the
    /// viewer can show are stored.
    pub fn checked(self) -> Result<Self, AbundioError> {
        if self.page < 1 {
            return Err(AbundioError::InvalidOperation("PDF page must be 1 or more".into()));
        }
        if let PdfZoom::Scale(s) = self.zoom {
            if !s.is_finite() || !(MIN_SCALE..=MAX_SCALE).contains(&s) {
                return Err(AbundioError::InvalidOperation("PDF zoom out of range".into()));
            }
        }
        Ok(self)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("a PDF position serialises")
    }

    /// A stored value, read back. Anything unreadable is `None`: the view
    /// then starts at its default rather than failing.
    pub fn from_stored(json: Option<String>) -> Option<Self> {
        json.and_then(|j| serde_json::from_str::<Self>(&j).ok())
            .and_then(|p| p.checked().ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_both_zoom_forms() {
        let p: PdfPosition = serde_json::from_str(r#"{"page":3,"zoom":"page-width"}"#).unwrap();
        assert_eq!(p.zoom, PdfZoom::Preset(PdfZoomPreset::PageWidth));
        let p: PdfPosition = serde_json::from_str(r#"{"page":3,"zoom":1.5}"#).unwrap();
        assert_eq!(p.zoom, PdfZoom::Scale(1.5));
        assert_eq!(p.to_json(), r#"{"page":3,"zoom":1.5}"#);
    }

    #[test]
    fn refuses_what_the_viewer_cannot_show() {
        assert!(serde_json::from_str::<PdfPosition>(r#"{"page":1,"zoom":"page-fit"}"#).is_err());
        assert!(serde_json::from_str::<PdfPosition>(r#"{"page":-1,"zoom":1}"#).is_err());
        let zero = PdfPosition { page: 0, zoom: PdfZoom::Scale(1.0) };
        assert!(zero.checked().is_err());
        let huge = PdfPosition { page: 1, zoom: PdfZoom::Scale(50.0) };
        assert!(huge.checked().is_err());
    }

    #[test]
    fn an_unreadable_stored_value_is_none() {
        assert_eq!(PdfPosition::from_stored(None), None);
        assert_eq!(PdfPosition::from_stored(Some("junk".into())), None);
        assert_eq!(PdfPosition::from_stored(Some(r#"{"page":0,"zoom":1}"#.into())), None);
        assert!(PdfPosition::from_stored(Some(r#"{"page":2,"zoom":"page-width"}"#.into())).is_some());
    }
}
