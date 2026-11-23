-- Agent control: Spawned tabs and user-named Tabs (docs/plans/agent-control.md, step 11).
-- spawned_by_pane: the pane whose Agent opened this Tab (a Spawned tab), or NULL.
-- user_named: 1 once the user has renamed the Tab by hand; an Agent may then no
-- longer rename it. Existing Tabs start at 0: no record says who named them.
ALTER TABLE tabs ADD COLUMN spawned_by_pane TEXT;
ALTER TABLE tabs ADD COLUMN user_named INTEGER NOT NULL DEFAULT 0;
