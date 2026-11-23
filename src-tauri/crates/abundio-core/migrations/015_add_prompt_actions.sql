-- Prompt actions: named, parameterised prompts fired at a running Agent from
-- the Action bar at the bottom of a pane. See docs/plans/prompt-actions.md.
--
-- One row per action, NOT a JSON blob keyed into `settings`. The blob looks
-- cheaper and is wrong: `settings` is key-value, so writing the list means
-- read-modify-write of an array, and SQLite serialises the write but not the
-- read before it. Two Windows both read, both append, both write, and one
-- append is gone -- the same loss `localStorage` has, by a different route.
-- Two INSERTs do not conflict. See ADR-0039.
--
-- App-global on purpose: actions are not scoped to a Profile or a Workspace
-- (see docs/plans/prompt-actions.md, "Deliberately not in v1"), so there is no
-- owning row and no foreign key here.

CREATE TABLE prompt_actions (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    body         TEXT NOT NULL,
    -- 'all' or 'set'. Stored as a discriminator rather than inferred from
    -- `scope_agent_ids` being empty: 'all' must pick up an Agent the user adds
    -- later, an explicit set naming every current Agent must not.
    scope_kind   TEXT NOT NULL DEFAULT 'all',
    -- JSON array of Agent ids. Meaningful only when scope_kind = 'set'; may be
    -- empty when the action's only Agent was deleted, which is kept and simply
    -- never rendered.
    scope_agent_ids TEXT NOT NULL DEFAULT '[]',
    -- JSON object keyed by parameter name, carrying type, default, and a
    -- toggle's on/off text. Parameter *names* are derived from the body's
    -- placeholders and are not stored here -- this is only their metadata, so
    -- an entry whose placeholder has been removed is inert, not a conflict.
    params_json  TEXT NOT NULL DEFAULT '{}',
    show_in_bar  INTEGER NOT NULL DEFAULT 1,
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_prompt_actions_position ON prompt_actions(position);
