-- A PDF's page and zoom (docs/plans/pdf-viewer.md), as JSON
-- (`{"page":3,"zoom":"page-width"}`), for a File window and an Orchestrator
-- tab. NULL: the first page at fit width. Checked by Rust on every write
-- (`pdf_position.rs`); an unreadable value reads as NULL.
ALTER TABLE file_windows ADD COLUMN pdf_position TEXT;
ALTER TABLE orchestrator_tabs ADD COLUMN pdf_position TEXT;
