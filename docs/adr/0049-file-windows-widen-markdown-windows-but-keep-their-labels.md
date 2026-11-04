---
status: accepted
---

# File windows widen Markdown windows, but keep their labels and shortcut id

The **Markdown window** (ADR-0046) becomes the **File window**. It can show anything a **File pane** can show: a text file (editable), an image, a file's live working-tree diff, or one file as a commit changed it. Markdown keeps its rendered and source views. The rest of ADR-0046 still holds: a File window belongs to one Workspace, is remembered in SQLite, closes and is remembered when its owner closes, and is forgotten when the user closes it.

There is at most one File window per **file and kind**, keyed the way File panes are keyed. A file's text window and its diff window can be open together, and one file at two commits gives two windows. Every kind is remembered and reopens with its Workspace.

We renamed the domain term and the table (`markdown_windows` → `file_windows`, with a `kind` column). We deliberately kept two old names:

- **Window labels stay `md-<uuid>`.** The label is the key `tauri-plugin-window-state` uses for a window's saved size and position. It is also the pattern the `markdown-window.json` capability matches, and the pattern `is_markdown_window_label` and `is_profile_window_label` test. A new `file-` prefix would mean handling both prefixes for good, because existing rows keep their labels. So `md-` is now just a historical prefix. **Do not "fix" it.**
- **The shortcut's action id stays `open-markdown-window`.** Keymap Overrides (ADR-0043) are stored by action id, so renaming it would silently drop every user's rebind unless we wrote migration code. Only its label changes, to "Open in Separate Window".

## Considered Options

- **One window per file path, switching between text and diff inside it** (like the rendered/source toggle). Rejected: you could not see a file and its diff side by side. It would also make File windows behave differently from File panes.
- **Not remembering live diffs**, because they may be empty after a restart. Rejected: one rule for every kind is easier to explain. A live diff with no changes left says so, as a diff pane does.
- **Renaming the label prefix and the action id too.** Rejected for the reasons above: the cost is permanent dual handling or migration code, and the benefit is only cleaner names.

## Consequences

- The window's permissions stay as narrow as `markdown-window.json` makes them. Diffs need git data, but app commands are callable from every window (there is no command manifest), so no new capability is needed.
- A live diff depends on a git section (staged, unstaged, against base), so a diff window's row stores the section, and a commit diff's row stores the commit id. The commit id is part of the window's key. Whether the section is part of the key follows whatever the live diff pane does (see the plan).
- The menu item is **absent**, not disabled, on a file that has no File window kind (binary, unsupported, folder, submodule). This follows the Row menu rule that a file's kind may change the menu's shape but its state may not.
