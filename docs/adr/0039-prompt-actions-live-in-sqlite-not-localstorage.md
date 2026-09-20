---
status: accepted
---

# Prompt actions live in SQLite, not in settingsStore

**Prompt actions** are stored in the app-global `settings` table and read over IPC. Every other app-global setting — themes, fonts, the Agent list, `smartImageDrop` — lives in `settingsStore` and persists to `localStorage`, so this is a deliberate exception and the only reason this ADR exists.

## What the normal path does

`localStorage` is isolated per Tauri webview on macOS (see the multi-window notes in CLAUDE.md). Cross-window sync therefore cannot use the browser `storage` event. The established pattern is: a Window writes its own copy, emits a Tauri event with **the changed data in the payload**, and every receiver writes that payload into its own `localStorage` and calls `useSettingsStore.persist.rehydrate()`.

That works because the values it carries are **scalars owned by one editor at a time**. Two Windows do not race to set the font size, and if they did, last-write-wins is the correct answer anyway.

## Why Prompt actions break it

A Prompt action list is not a scalar, and it does not have one editor.

The **in-pane popover** (see the **Action bar** entry in CONTEXT.md) exists precisely so authoring happens *often*, *mid-session*, and *in whatever Window the user is already working in* — while the Settings window may be open on the same list. The broadcast ships the whole array, so:

1. Window A's popover appends action X and broadcasts `[…, X]`.
2. The Settings window, holding `[…]` from before, saves an unrelated edit and broadcasts `[…']`.
3. X is gone. No error, no conflict, no way for the user to know.

The `agents` list has the same shape and has never bitten, because adding a custom Agent is rare and done in one place. The popover removes exactly those two properties.

The severity differs too. Losing a font-size change is an annoyance the user re-does without noticing. Losing a Prompt action loses **content the user authored** — a prompt they composed, parameters they typed. That is a different class of bug, and it is the class that justifies paying for a different storage layer.

## What we do instead

Prompt actions get **their own table, one row per action**.

The obvious cheaper move — a JSON blob under a key in the existing `settings` table — does not work, and it is worth saying why, because it looks like it should. That table is key-value (`001_init.sql:12-15`), so writing the list means read-modify-write of an array. SQLite serialises the *write*, but not the read that preceded it: two Windows both read `[…]`, both append, both write, and one append is gone. That is the same loss as `localStorage`, reached by a different route. Only row-per-action removes it, because two inserts do not conflict.

- **One writer, and no array to lose.** Appending is an INSERT. There is no per-webview copy to diverge and no whole-list overwrite.
- **The broadcast survives, but demoted.** It carries *"the list changed, re-read it"* instead of the list itself, so a receiver that misses an event self-corrects on its next read rather than persisting a stale snapshot.

The `settings` table still does what it is good at — **Agent seeding** (ADR-0037) claims its one-time run there atomically — which is a single scalar under a single key, the shape it was built for.

## Consequences

- **Reads become IPC**, not synchronous store access. Components need the usual loading state, and the Settings window needs the same IPC rather than reading a hydrated store.
- **`settingsStore` is no longer "where global settings live".** It is now "where global *preferences* live"; user-authored content lives in SQLite. Anything new should ask which of the two it is — the test is whether losing it silently would cost the user work they did.
- The global **Show Action bar** toggle is a preference, not content, so it stays in `settingsStore` under Settings ▸ Terminal. The two halves of this feature deliberately live in different places.
