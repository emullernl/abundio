# Drop files onto terminals/agents (path insert + smart image paste)

## Context

Abundio has **no handling for OS file drops** today — dragging a file from Finder/Explorer onto a terminal pane does nothing useful. We want:

1. **Base behaviour (always on):** drop one or more OS files onto a **terminal pane** → insert their path(s) into that pane's PTY as input (never auto-executed).
2. **Smart image drop (a setting, default on):** when a single image is dropped onto an **agent-mode PTY**, instead of inserting a path, place the image (as PNG) on the OS clipboard and send the Agent a paste keystroke (`Ctrl+V`) so it ingests the image as if pasted from the clipboard.

This is greenfield — no existing OS-drop code to migrate. The existing **Pane** drag (mouse-driven pane reordering: `usePaneDrag.ts`, `dragPaneHitTest.ts`, `dragPaneStore.ts`) is orthogonal — it listens to `mousedown`/`mousemove`, never fires on an OS drag, so the two systems don't collide.

### Research that shaped the design (keystone facts)

- Only **Claude Code (macOS)** and **Gemini CLI** actually ingest a *clipboard image* on `Ctrl+V`. **Codex, Copilot, OpenCode, Aider do not.** Every agent (and a plain shell) accepts a *file path*.
- Claude Code reads the macOS clipboard via `osascript … «class PNGf»` — it wants **PNG**. `arboard` (which Tauri's clipboard-manager uses) writes images to `NSPasteboard` as **TIFF**, which Claude's read ignores. → On macOS we must write **`NSPasteboardTypePNG`** ourselves.
- In a plain shell `Ctrl+V` is `quoted-insert` (inserts a literal control byte) — so the clipboard trick must never fire in shell-mode.
- Abundio already tracks, per PTY: agent-mode vs shell-mode (`ptyActivityStore.agentPtyIds`) and which agent (`detectedAgentIds`). The design below only needs the agent/shell bit.
- Tauri's `dragDropEnabled` **defaults to `true`**, so OS file drops are already captured by the webview app-wide (HTML5 file-drop is already suppressed → Monaco etc. won't regress). We only need to *listen*.

## Decisions (resolved via grilling)

1. **Strategy:** layered — path insert is the base for every drop; the clipboard-image trick is an override.
2. **Clipboard-trick gate:** **agent-mode panes only** (shells always get the path).
3. **Per-agent gating:** **none** — the trick fires for *every* agent in agent-mode, with **no path fallback** when the agent can't read clipboard images. Deliberate simplicity-over-correctness trade-off (recorded in `CONTEXT.md` Flagged ambiguities).
4. **Drop target:** the terminal pane **under the cursor**, with a **highlight** during drag-over; the pane is **focused** on drop.
5. **Path format is mode-aware:** shell-mode → POSIX single-quote when the path contains spaces/special chars; agent-mode → **raw** literal path. Multiple files space-separated, with a trailing space. Inserted via **bracketed paste** → never executed.
6. **Image scope:** broad raster set (png, jpg/jpeg, gif, webp, bmp, tiff, heic/heif, avif — anything the Rust `image` crate decodes), re-encoded to **PNG** for the clipboard. SVG excluded.
7. **Clipboard clobber:** the prior clipboard is **not restored** (a restore would race the Agent's async read).
8. **Setting:** `smartImageDrop` (Terminal section, **default ON**) gates *only* the image-clipboard override; the base path insert has no toggle.
9. **Platform:** clipboard trick built **cross-platform** (native PNG on macOS; `arboard` on Windows/Linux, format verified per agent).
10. **Multi-file / mixed drops:** the clipboard trick fires **only for a single dropped image**; any multi-file drop (even all images) inserts paths.

### Decision logic (per drop: `paths`, target `paneId`/`ptyId`)

```
mode   = agentPtyIds.has(ptyId) ? "agent" : "shell"
single = paths.length === 1

if (mode === "agent" && smartImageDrop && single && isImagePath(paths[0])) {
  try {
    await invoke("set_clipboard_image_from_path", { path: paths[0] }) // decode → PNG → OS clipboard
    pty.write(ptyId, "\x16")                                          // Ctrl+V (0x16)
  } catch {
    insertPaths(paneId, paths, mode)   // decode/clipboard failure → path fallback (technical, not the capability case)
  }
} else {
  insertPaths(paneId, paths, mode)     // getTerminal(paneId).term.paste(buildDropText(paths, mode))
}
```

## Implementation

### 1. Rust: image → clipboard command (`src-tauri/src/`)
- New `clipboard_image.rs` (module style mirrors existing files; errors as `AbundioError`):
  - `#[tauri::command] pub async fn set_clipboard_image_from_path(path: String) -> Result<(), AbundioError>`
  - Read bytes → decode with `image` crate (`image::load_from_memory` / `ImageReader::open(..).decode()`) → `to_rgba8()` (width/height + RGBA buffer).
  - **macOS:** encode to **PNG** bytes and write `NSPasteboardTypePNG` to the general `NSPasteboard` (clear first), via `objc2` + `objc2-app-kit` (or `objc`/`cocoa`). This is the load-bearing bit — Claude's reader wants PNG.
  - **Windows/Linux:** `arboard::Clipboard::new()?.set_image(ImageData { width, height, bytes: rgba })`. (arboard sets CF_DIB on Windows, `image/png` target on X11/Wayland.) Flag for verification against Gemini's reader.
  - Map all errors into a new `AbundioError::Io`/`AbundioError::Clipboard` variant (add `Clipboard` to `error.rs` if a distinct variant reads better; otherwise reuse `Io`).
- Register the command in `lib.rs` `invoke_handler` (and in `commands.rs` if that's where the handler list lives).
- No new capability entry needed — it's our own command, not a plugin command. (Verify only that custom commands need no allowlist, consistent with `pty_write`.)

### 2. Rust deps (`src-tauri/Cargo.toml`)
- Add `image = "0.25"` (decode + PNG encode).
- Add `arboard = "3"` (Windows/Linux image clipboard). It's likely already transitive via `tauri-plugin-clipboard-manager`; pin it explicitly.
- macOS deps: `objc2`, `objc2-app-kit`, `objc2-foundation` under `[target.'cfg(target_os = "macos")'.dependencies]` (or reuse whatever obj-c bridge Tauri already pulls in).

### 3. Frontend IPC (`src/lib/ipc.ts`)
- Add `setClipboardImageFromPath(path: string) => invoke<void>("set_clipboard_image_from_path", { path })`, routed through the demo-mode chokepoint (§9).

### 4. Pure helpers + tests (`src/lib/fileDrop.ts`, `src/lib/__tests__/fileDrop.test.ts`)
- `IMAGE_EXTENSIONS` set; `isImagePath(path): boolean` (case-insensitive extension match, svg excluded).
- `formatDroppedPath(path, mode: "shell" | "agent"): string` — agent → raw; shell → POSIX single-quote only when it contains a space or shell metachar (wrap in `'…'`, escape embedded `'` as `'\''`).
- `buildDropText(paths, mode): string` — `paths.map(p => formatDroppedPath(p, mode)).join(" ") + " "`.
- Vitest: raw vs quoted by mode, embedded-quote escaping, multi-file joining, image-extension detection (incl. uppercase, `.tar.gz` not an image, svg excluded).

### 5. Drop event + decision wiring (`src/hooks/useTerminalFileDrop.ts`)
- New hook, mounted once in `App.tsx` (Profile-bound root → runs in every Profile window; Settings window doesn't mount it).
- `getCurrentWebview().onDragDropEvent((e) => …)` from `@tauri-apps/api/webview`. Handle `enter`/`over`/`drop`/`leave`:
  - **Position is in physical pixels** — convert to CSS px (`x / window.devicePixelRatio`) before hit-testing.
  - Hit-test: `document.elementFromPoint(x, y)?.closest("[data-pane-id]")` → `paneId`; resolve `ptyId = getTerminal(paneId)?.ptyId`. (Reuses the same `data-pane-id` attribute the pane-drag `hitTest` uses.)
  - `enter`/`over` → set hovered pane in the drop store (§6) for the highlight; `leave` → clear.
  - `drop` → clear highlight; if a terminal pane was hit, `focusPane(paneId)` then run the **decision logic** above; otherwise ignore (drops outside a terminal pane do nothing).
- `mode = usePtyActivityStore.getState().agentPtyIds.has(ptyId) ? "agent" : "shell"`.
- `smartImageDrop` read non-reactively via `useSettingsStore.getState()`.
- Path insert uses `getTerminal(paneId).term.paste(buildDropText(paths, mode))` — bracketed paste through the existing `onData → pty.write` path (same mechanism as `pasteIntoTerminal`), so it targets the right PTY regardless of focus and is never executed.
- Clipboard trick: `await ipc.setClipboardImageFromPath(paths[0])` then `pty.write(ptyId, "\x16")`. (Keep `0x16` as the trigger per Claude's docs; if testing shows a terminal needs it, fall back to an empty bracketed paste `\x1b[200~\x1b[201~` — note in code.)

### 6. Highlight overlay (`src/lib/fileDropStore.ts` + `src/components/FileDropHighlight.tsx`)
- `fileDropStore.ts`: ephemeral state (plain module pub/sub like `dragPaneStore`, or a tiny Zustand store) holding `hoverPaneId: string | null` with `setHoverPane`/`clear`.
- `FileDropHighlight.tsx`: absolutely-positioned overlay (border glow / tinted fill, `pointerEvents: "none"`) shown when `hoverPaneId === paneId`. Render it inside `TerminalSlot.tsx` next to the existing `<PaneDropIndicator paneId={paneId} />` (≈ line 348) so it inherits the pane's box.

### 7. Setting (`src/stores/settingsStore.ts`)
- Add `smartImageDrop: boolean` (default `true`) to: `SettingsState` interface, `PERSISTED_DEFAULTS`, initial state, a `setSmartImageDrop` setter, and `partialize`.
- An additive default-`true` boolean rehydrates correctly from initial-state defaults without a migration; bump the persist `version` and add a pass-through migration entry only to stay consistent with the established pattern.

### 8. Cross-window sync + Settings UI
- `src/SettingsApp.tsx`: add `smartImageDrop` to the `SettingsSlice` type and `sliceOf()` so the `settings-store-changed` broadcast keeps windows in sync (same as other terminal settings).
- `src/components/SettingsPanel.tsx`: add a `Toggle` in the existing **`terminal-font`** section (which already hosts terminal-wide toggles like GPU acceleration), bound to `smartImageDrop`/`setSmartImageDrop`:
  - Label: **“Drop images to agents as images”**
  - Description: *“When you drop an image onto a running agent, paste it via the clipboard so the agent recognises it — instead of inserting the file path. Other dropped files always insert their path.”*
  - (Optional polish: factor a “Terminal Behavior” section if `terminal-font` gets crowded — not required.)

### 9. Demo mode (`src/lib/demo/`)
- Mock `set_clipboard_image_from_path` as a no-op in `mockInvoke` so `pnpm demo` / `pnpm demo:web` don't error. OS drag-drop events don't fire in the web demo, so no further stubbing needed.

## Docs to land

### CONTEXT.md — already updated
**File drop** and **Smart image drop** terms added to Language; the “fires for every agent, no fallback, no clipboard restore” trade-off captured under Flagged ambiguities.

### ADR — intentionally none
Clears two of the three ADR bars (surprising; a real trade-off) but **fails “hard to reverse”** — it's a setting + a gate, cheap to change. Per the all-three-or-skip rule, the `CONTEXT.md` flagged note is the right weight. Revisit if we later add per-agent capability gating or change the clipboard mechanism.

## Verification

1. **Rust:** `cd src-tauri && cargo check` and `cargo test`.
2. **Frontend:** `pnpm build` (tsc + vite), `pnpm check`, `pnpm test` (incl. new `fileDrop.test.ts`).
3. **Format unit logic:** assert mode-aware quoting and image detection in Vitest (no Tauri needed).
4. **End-to-end (manual, macOS first):**
   - Drop a non-image file onto a **plain shell** → path inserted, **quoted** if it has spaces, command line not executed; press Enter resolves correctly.
   - Drop the same onto a **Claude Code** pane → **raw** path inserted (no quotes/backslashes).
   - Drop a single **PNG** onto Claude Code (setting ON) → image attaches as `[Image]` (confirms the native `NSPasteboardTypePNG` write + `Ctrl+V` path). Repeat with a **JPG/HEIC** → still attaches (confirms decode→PNG).
   - Drop the same image with the setting **OFF** → path inserted instead.
   - Drop **two images** onto Claude Code → both inserted as paths (single-image-only rule).
   - Drop an image onto a **non-supporting agent** (e.g. Codex) → clipboard is replaced, nothing attaches, no path inserted (the accepted trade-off — confirm it matches expectation, not a bug).
   - Hover a file over split panes → the **pane under the cursor** highlights; drop lands there and focuses it.
   - **Cross-platform:** repeat the single-image case on Windows and Linux; confirm `arboard` path doesn't error and Gemini ingests where supported.
   - **Multi-window:** toggle the setting in the Settings window → confirm it propagates to open Profile windows; drop still targets the correct window's pane.
   - **Demo mode** (`pnpm demo`): no clipboard/IPC errors.
