# Navigator Shortcuts

Keyboard control of the Navigator's scope toggle and status filter. See the
**Navigator** and **Navigator Shortcut** entries in `GLOSSARY.md`.

## Decisions

| Action | Default (macOS / Win+Linux) |
|---|---|
| Switch Opened ⇄ All workspaces | `Tab` (Shift + the bound key does the same) |
| Toggle Waiting / Working / Ready / Idle / Error | `Cmd+1`–`5` / `Ctrl+1`–`5`, chip order |
| Clear the status filter | `Cmd+0` / `Ctrl+0` |

- A status key toggles, exactly like clicking its chip.
- All seven are Keymap actions (Settings ▸ Keyboard, category "Navigator"),
  stored as ordinary `app:<action>` Overrides. They act only while the
  Navigator is open; otherwise the key is not claimed at all.
- **Shift alias**: Shift + the scope key's Chord also switches scope, unless
  that Chord already has Shift. Follows rebinds; not its own Settings row.
- **Conflicts**: a Navigator Shortcut clashes with another Navigator Shortcut,
  and with an app Shortcut that still acts while the Navigator is open. App
  Shortcuts that stand down under the Navigator (Prompt actions, Fleet
  spotlight, Fleet zoom reset) and editor Shortcuts never clash with one.
- **Bare keys**: a Navigator Shortcut may be a key with no Cmd/Ctrl/Alt if it
  never types or edits in the search box: Tab, PageUp/PageDown, Insert,
  F-keys. Win/Linux's "Ctrl+digit is a terminal control code" warning is
  skipped for them (they never reach a terminal).
- **Footer hint line** in the dialog: the filter keys plus `↑↓ move · ←→ fold ·
  ↵ go · esc close`. The five status keys collapse to a range (`⌘1–5`) when
  they share modifiers and sit on consecutive digits in chip order; otherwise
  each is listed. Unbound ones are left out.
- The Navigator still opens fresh (Opened scope, no filter, empty search).
- Navigator Shortcuts are live only while the Navigator has the user's
  attention: topmost on the overlay stack, with focus in it (or nowhere). A
  dialog opened over it (New task, New workspace) keeps its own Tab.
- **Trade-off**: with Tab and Shift+Tab claimed, the scope buttons and status
  chips are no longer reached by Tab focus traversal; their Shortcuts replace
  that path. A bare key pressed while an input method is composing is left
  to the input method.
- Settings notes (never asks) when a rebind takes the scope key's Shift
  alias, or when the scope key's new alias is already taken.

## Steps (one branch, ordered commits)

1. **Keymap** (`lib/keybindings.ts`)
   - New actions `navigator-toggle-scope`, `navigator-filter-{waiting,working,
     ready,idle,error}`, `navigator-filter-clear`; defaults; `ACTION_META`
     with category `"Navigator"`.
   - Gate every Navigator action on `navigatorKeysLive()` (new pure module
     `lib/navigatorKeys.ts`, set by the Navigator on mount/unmount).
   - `handleKeyDown`: a binding muted by an open overlay now `continue`s to
     the next binding instead of `return`ing, so a Prompt action on `Cmd+1`
     no longer hides the Navigator's binding on the same Chord.
   - Shift alias appended to the active bindings.
   - `standsDownUnderNavigator(action)` (Prompt actions, Fleet spotlight,
     Fleet zoom reset): `handleKeyDown` skips them while the Navigator is
     open, so the keymap itself enforces the rule the conflict check assumes.
2. **Conflicts** (`lib/keymapConflicts.ts`, `lib/chords.ts`): `"navigator"`
   scope with the clash rule above; `chordVerdict` takes the scope for the
   bare-key and Ctrl+digit rules.
3. **Settings ▸ Keyboard**: rows for Navigator actions use the `navigator`
   scope and the new category.
4. **Navigator**: register handlers while mounted; footer hint line built by
   the pure `navigatorHints` in `lib/navigatorKeys.ts`; chip and toggle
   tooltips name their Shortcut.
5. **Tests**: chord verdicts, conflict rule, keymap gating / overlay
   continue / Shift alias, hint-line ranges, Navigator key handling.
