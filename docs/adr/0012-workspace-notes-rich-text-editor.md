# Workspace Notes use a rich-text editor (TipTap) with JSON storage

Each Workspace has a single **Note** — a scratchpad for free text and
checklists, edited in the right sidebar's Notes tab. We built it on **TipTap**
(ProseMirror) as a true rich-text editor and persist the document as **TipTap
JSON** in a `content TEXT` column (`notes` table, keyed by `workspace_id`).
This deliberately diverges from how the rest of the app handles rich content —
as **Markdown** rendered by the file Preview pane (ADR-0001) — and from a
plausible "store notes as Markdown" default.

## Why

The user asked for a *simple rich-text editor where you edit the note and
insert checklists* — explicitly **not** a Markdown editor with a preview. A
Markdown-source-plus-preview surface (the obvious reuse of the existing
`@uiw/react-markdown-preview` stack) was rejected for that reason: it exposes
syntax and a mode toggle, which is the opposite of "just type and tick boxes".

Given a WYSIWYG editor, the storage format follows from it:

- **TipTap JSON** round-trips losslessly with `getJSON()` / `setContent()` — no
  serializer to maintain, and Rust treats the column as an opaque string.
- **Markdown storage** would re-introduce a lossy Markdown serialization layer
  (`tiptap-markdown`) and the very syntax we're avoiding, for the sole benefit
  of portability/greppability — which notes don't need (they aren't files and
  aren't indexed by workspace search).

## Considered options

- **Reuse the Markdown preview stack** (source textarea + rendered preview with
  clickable checkboxes): rejected — it's a Markdown editor, which the
  requirement ruled out.
- **Hand-rolled `contentEditable`**: rejected — selection, undo, paste, and
  checklist toggling are exactly where these become fragile; "simple" was the
  goal.
- **Lexical** instead of TipTap: comparable checklist support, more boilerplate;
  TipTap's first-class `TaskList`/`TaskItem` matched the headline feature with
  the least glue.

## Consequences

- TipTap (ProseMirror) is a new editor dependency alongside Monaco and the
  Markdown stack — three editing technologies in one app. Accepted as the cost
  of meeting the requirement well.
- Stored notes are TipTap JSON: **not human-readable, portable, or greppable**
  by the workspace full-text search. If export-to-Markdown is ever wanted it's a
  clean later addition (JSON → Markdown), but changing the *stored* format would
  require a data migration of existing notes.
- The editor is intentionally a cherry-picked subset of `StarterKit` (bold,
  italic, strike, bullet lists, checklists, paragraphs) — headings, ordered
  lists, links, code blocks, etc. are off, keeping it a notepad rather than a
  document editor.
