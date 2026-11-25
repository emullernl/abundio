# Paste tray and Smart image paste

An Agent shows a pasted image only as a label such as `[Image #1]`. The **Paste tray** (`GLOSSARY.md`) shows the images themselves, as small thumbnails at the bottom of the pane, above the Action bar. **Smart image paste** makes the normal paste shortcut send an image-only clipboard to the Agent.

## Decisions

- **Where**: a slim row at the bottom of the pane, between the terminal and the Action bar (near the Agent's prompt). Mounted in `TerminalSlot`, so it also appears in Fleet tiles and the Peek.
- **What fills it**: a **Smart image drop**, a **Smart image paste**, and `Ctrl+V` typed into an agent-mode pane while the clipboard holds an image.
- **Clipboard rule** (one rule for every path): an image, no text, no copied files. Text wins; Finder/Explorer-copied files are left to the normal paste (their icon is never shown as an image).
- **Clears**: when the pane goes Working, when the Agent leaves agent mode or exits, and on the PTY's restart. Its × hides one image or the whole tray. It never takes an image back from the Agent.
- **Click**: shows the image larger over the pane; Escape or a click outside closes it.
- **Every agent-mode pane**, whatever the Agent. Plain shell panes never get a tray, and an image-only paste there does nothing, as before.
- **This Window only**, in memory, never saved.
- **Settings**: `pasteTray` (Terminal section, "Show pasted image thumbnails", on). Smart image paste follows `smartImageDrop`.
- **Platforms**: `Cmd+V` on macOS; the `paste` action (`Ctrl+Shift+V` by default) on Windows/Linux.

## Rust (desktop crate, `clipboard_image.rs`)

1. `clipboard_image_peek() -> Option<PastedImage>`: reads the clipboard on a blocking thread. Returns `None` unless the clipboard rule holds. `PastedImage { thumb, full, width, height }`: `thumb` is a PNG at most 160 px on its longest side, `full` at most 1600 px, both base64 (invoke results that carry bytes are base64).
2. Pure helpers, tested: the rule (`has_text`, `has_files`, `has_image` → paste or not) and the scaling (reuse the shape of `prompt_attachments::fit_within`).
3. Desktop scope in `commandScope.ts` (it reads this computer's clipboard).

## Window

4. `stores/pasteTrayStore.ts`: images per PTY id (at most 9, oldest dropped), `add`, `remove`, `clear`. Clears itself from `subscribeStatusChange` (next status Working, or mode leaving agent).
5. `lib/pasteTray.ts`: `notePastedImage(ptyId)` — if the setting is on and the PTY is in agent mode, peek and add. Pure rule for when the tray clears.
6. Paths:
   - `useTerminalFileDrop`: after a Smart image drop's `Ctrl+V`, `notePastedImage`.
   - `terminalManager` `onData`: user input exactly `\x16` in an agent-mode PTY → `notePastedImage` (the byte still goes to the PTY untouched).
   - **Smart image paste**, `lib/smartImagePaste.ts`: `pasteIntoTerminal` with empty clipboard text, and on macOS a `Cmd+V` keydown in the terminal (`attachCustomKeyEventHandler`), ask `clipboard_image_peek`; with an image, in an agent-mode PTY, with `smartImageDrop` on → write `\x16` and add the image to the tray. A native `paste` event carrying no text is dropped, so xterm never sends an empty bracketed paste.
7. `components/Terminal/PasteTray.tsx` and its larger view (`useEscapeKey`).
8. Setting and its toggle; glossary entries already written.

## Tests

- Rust: the clipboard rule, scaling, base64 round trip.
- TS: `pasteTrayStore` (cap, clear on Working, clear on leaving agent mode), `notePastedImage` gating (setting, agent mode), Smart image paste decisions (text wins, shell pane does nothing, setting off does nothing).

## To verify in the real app

- WKWebView may not fire `paste` at all for an image-only clipboard; the `Cmd+V` keydown path covers that.
- Which Agents take a clipboard image on `Ctrl+V` now (the glossary says only Claude Code and Gemini CLI; Copilot may have changed). Update the Flagged ambiguity if it has.
