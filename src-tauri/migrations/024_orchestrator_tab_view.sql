-- A markdown file's view in an Orchestrator tab (ADR-0061): 'rendered',
-- 'source', or NULL to follow the "Open markdown rendered" setting. A tab
-- that asked for a preview (side by side, before ADR-0061) opens rendered.
-- The preview column stays, no longer read.
ALTER TABLE orchestrator_tabs ADD COLUMN view TEXT CHECK (view IN ('rendered', 'source'));
UPDATE orchestrator_tabs SET view = 'rendered' WHERE preview = 1;
