# Settings window reorganisation — two-level navigation

## Context

The Settings window has accreted rather than been designed. `src/components/SettingsPanel.tsx` is a **single 2465-line file** holding all eight nav sections, every sub-component, and eight inline icon components. The grouping has drifted from the labels:

- **"Terminal Font"** (`:2125–2232`) actually contains GPU acceleration, smart image drop, scrollback, *and* the font controls.
- Fonts are split across two sidebar entries (`terminal-font`, `ui-font`) that together hold four controls.
- **Shell** is a nav section with exactly one control.

The nav rail is also **flat** — eight sibling entries with no structure, hand-written one after another at `:2024–2086` with no array or map. It gives the user no model of *what kind* of thing each page configures.

Three defects sit underneath the layout problem:

1. **Three settings editable in the Settings window don't propagate to other windows.** `SettingsApp.tsx:136–172` hand-lists 15 keys to broadcast, twice (a type and a mapping); `shellPath`, `autoCheckUpdatesEnabled` and `editorWordWrap` are missing. ADR-0008 *says* the sync "covers the `settingsStore` persisted partial" — the hand-list is drift from what the ADR describes, and the rule it left behind ("remember to add your key") has been forgotten three times.
2. **Deep-linking is broken from a closed window.** `window_management.rs:81` encodes `index.html?settings&section=X` — its comment states the intent — but nothing on the frontend ever reads `location.search` (`main.tsx` parses only the window *label*). Rust only emits `settings-set-section` on the already-open branch (`:66–75`), so File ▸ "Manage Profiles…" from a closed window lands on Theme.
3. **`settingsUiStore` is entirely dead.** `requestSettingsSection()` has zero callers, and it structurally *cannot* work: the Settings window is a separate webview (ADR-0008), so a value written to zustand in a Profile-bound window is invisible there. `consumeRequestedSection()` (called at `SettingsPanel.tsx:1830`) returns `null` forever. Its `SettingsSection` union lists only 6 of the 8 ids, papered over by a cast at `:1831`.

Four persisted settings are also unreachable: `markdownPreviewAutoOpen` (no UI at all), `editorWordWrap` (Monaco command only), `debugActivityMeter` (command palette only), and the update skip/snooze state (set-only — no way to undo).

**Intended outcome:** a two-level nav — three group captions over eight leaf pages — organised by *what is being configured*, one file per page, working deep-links, and every global setting both reachable and propagating.

## Information architecture

Group captions are **presentation only**: non-clickable, non-focusable `<div>`s. Only the eight leaves are pages, and only leaf ids are addressable — they cross the Rust→JS boundary as deep-link strings, so they are vocabulary, not implementation detail. There is deliberately no `section=appearance`: no caller wants one, and inventing it would be a vocabulary with no speakers.

| Group caption | Leaf id | Nav label | Contents |
|---|---|---|---|
| **APPEARANCE** | `theme` | Theme | Dark/Light theme card grid |
| | `fonts` | Fonts | Interface font + UI font size · divider · Terminal font + terminal font size |
| **PANES** | `terminal` | Terminal | GPU acceleration · Scrollback lines · Smart image drop · Default shell · **Diagnostics** group (terminal activity meter) |
| | `editor` | Editor | Wrap long lines · Open a preview pane for markdown files · a *pointer* (not a control) to the preview title bar for colour mode |
| **APPLICATION** | `agents` | Agents | Status Hooks toggle · agent list + provisioning footprints · Add custom agent |
| | `profiles` | Profiles | Profile list (rename/delete) + Add profile |
| | `github` | GitHub | PR polling toggle + check interval |
| | `updates` | Updates | Version / check / install · Auto-check toggle · **Notifications** group · copyright footer |

**The organising principle** is: what you *look at* (Appearance), the *pane types* (Panes), and the *application itself* (Application). **Terminal** configures the terminal pane and its PTY; **Editor** is its sibling, configuring the file pane and preview pane. This is why the editor settings are not folded into Appearance — `markdownPreviewAutoOpen` decides whether `buildFilePaneLayout` spawns a Preview pane in a vertical 50/50 split (`lib/markdownPreview.ts:45`), which is layout behaviour, not look.

### Decisions taken, with their reasons

- **Both fonts live on `fonts`, not on `terminal`.** You choose interface and terminal font *relative to each other*, so they belong side by side; the Terminal page stays about PTY and rendering behaviour, never about looks. This keeps the plan's one acknowledged cross-section coupling: `handleTerminalFontSizeChange` calls `setAllTerminalsFontSize` from `lib/terminalManager`, and moves into `FontsSection`.
- **The leaf is called "Editor", not "Files" or "Editor & Preview".** It configures both a file pane and a preview pane, so it is not an exact glossary term — but "Files" collides with the Explorer tab in users' heads, and "Editor & Preview" truncates in a 160px rail where every other label is one word. Paid for with one CONTEXT.md line stating that Settings ▸ Editor covers file-pane *and* preview-pane concerns; **"Editor" stays a UI label and never enters the domain glossary.**
- **Leaf rows keep icons and take no extra indent.** The caption carries the hierarchy on its own; indenting as well would be a third redundant signal and would break the icon column's vertical alignment. Rail stays 160px.
- **Nav captions get their own component**, `NavGroupLabel` — smaller (10px), dimmer, wider letter-tracking, no icon column. `SectionLabel` (`:166`) keeps its exact current styling for **in-page** group headings ("GPU Acceleration", "Diagnostics", "Notifications"), so five existing pages get zero visual churn. Two hierarchy levels, two components — reusing `SectionLabel` in the rail would have a page-group and a control-group claiming equal rank.
- **No section is remembered across opens.** Closing the Settings window destroys its webview (ADR-0008), so persistence would need a new settings key plus a broadcast-denylist entry as a write-on-use breadcrumb. `DEFAULT_SECTION = "theme"` — Cmd+, is deterministic, and the deep-link already covers "take me somewhere specific".
- **No settings-wide search.** `SearchInput` (`:184`) has exactly one call site — inside `FontPicker` (`:329`) — and stays font-only.
- **Preview color mode stays on the preview title bar** (ADR-0013). Its icon *is* the state readout, which a Settings row can't be. The Editor page carries one line of help text pointing at it, so its absence reads as intentional rather than as a gap.
- **The section stays named "GitHub", not "Integrations".** It holds one integration and there is no second one pending — dev environments are auto-detected with no settings. Naming a category with one member is speculative generality; CONTEXT.md's one deliberate exception (**Profile**, `:198`) is flagged *as* an exception with a stated reason.
- **Smart image drop stays in Terminal**, honouring CONTEXT.md:168's existing "(Terminal section, on by default)" — wrong today, made true here. Its label becomes the canonical glossary term, **Smart image drop**.
- **No About block is built.** `lib.rs:68–74` already supplies name/version/copyright/license to the native `PredefinedMenuItem::about` on every platform, and Updates shows the version anyway.

### Deep-link vocabulary — five of eight ids survive

Splitting Appearance into Theme + Fonts is what saves them. `theme`, `agents`, `profiles`, `github`, `updates` are unchanged; only three aliases are needed.

**No call site changes.** `lib.rs:841` (`"profiles"`), `CommandPalette.tsx:78` (`"profiles"`), `PullRequestsSection.tsx:164` (`"github"`), `App.tsx:609` and `lib.rs:835` (no section) all survive.

## Execution order

All of this lands on the existing (currently empty) `feat/reorganise-settings` branch as ordered commits — per `feedback_single_branch_no_pr_split`, not split into separate PRs. Each step is independently verifiable before the next builds on it:

1. **Broadcast fix** — `SettingsApp.tsx` only; independent of the reorg.
2. **Pure-move extraction** — cut into `Settings/`, no behaviour change.
3. **Regroup + two-level nav + deep-link + new controls.**
4. **Docs** — CONTEXT.md.

Steps 2 and 3 must be separate commits: step 2's entire verification is that `git diff --stat` reads as moves, and folding it into the regroup destroys that property — a 2465-line deletion beside 14 new files reads as a rewrite, and a real behaviour change could hide in it. Step 1 goes first so the cross-window retest at the end exercises the final code.

## Step 1 — propagate every global setting across windows

Touches `src/SettingsApp.tsx` only.

Replace the twice-hand-listed 15-key `SettingsSlice` + `sliceOf` (`:136–172`) with **all of `partialize` minus an explicit denylist**. This inverts the failure mode: a forgotten key now propagates instead of silently not propagating, and it restores what ADR-0008 already claims happens.

```ts
const NOT_BROADCAST = new Set([
  "sidebarWidth", "rightSidebarWidth", "rightSidebarPrRatio",  // written continuously during a drag
  "activityByteThreshold",                                      // written by the meter overlay at high frequency
  "lastOpenedDevEnvId",                                         // a write-on-use breadcrumb, not a preference
]);
```

The denylist is defensible because `settingsStore` **is** the global store by construction — per-Window state lives in `windowUiStore` (ADR-0007/0008). So the exclusions are about *noise*, not scope: sidebar widths are global by CONTEXT.md:156, but broadcasting them would live-resize your other windows mid-drag when last-drag-wins-on-next-open is the intent.

Keep the ADR-0014 comment on `skippedUpdateVersion` / `updateSnoozedUntil`. Note the bridge runs in **every** window (`main.tsx:12`), so propagation is bidirectional — a command-palette toggle in a Profile window reaches Settings too.

**Test:** `src/__tests__/settingsSync.test.ts` — assert `NOT_BROADCAST ⊆ Object.keys(partialize(state))`, so a renamed key can't rot the denylist silently, and assert the three regression keys (`shellPath`, `autoCheckUpdatesEnabled`, `editorWordWrap`) are in the broadcast result.

## Step 2 — split SettingsPanel.tsx (pure moves)

Create `src/components/Settings/`, matching the repo's per-feature convention (`WorkspaceEnv/`, `GitChanges/`, `Notes/`). The old file stays at its path and imports the new leaves, so the diff is verifiable as moves. **14 files, max 570 lines.**

| File | From (old lines) | ~lines |
|---|---|---|
| `primitives.tsx` | 166–228, 522–551 | 210 — `SectionLabel`, `SearchInput`, `NavItem`, new `NavGroupLabel`, `Toggle`, new `ToggleRow` |
| `FontPicker.tsx` | 229–360 | 140 — `FontRow` + `FontPicker` |
| `NumberSteppers.tsx` | 361–521 | 170 — `FontSizeControl`, `ScrollbackControl` |
| `ThemeCard.tsx` | 76–164 | 95 — `TerminalPreview` + `ThemeCard` |
| `icons.tsx` | 552–614, 1077–1134, 1371–1389, 1673–1693 | 140 — the nav icons |
| `AgentsSection.tsx` | 650–1076, 2292–2387 | 570 — section + `AgentRow` + `AddAgentForm` + `HookFootprint`/badges |
| `ProfilesSection.tsx` | 1488–1672, 2389–2435 | 320 — section + `ProfileRow` + `AddProfileForm` |
| `UpdatesSection.tsx` | 1136–1364 | 260 |
| `GithubSection.tsx` | 1696–1808 | 120 |
| `ThemeSection.tsx` | 2088–2124 | 45 |
| `FontsSection.tsx` | 2166–2232, 2233–2254 | 160 — both font pickers + both size steppers |
| `TerminalSection.tsx` | 2125–2165, 2255–2291 | 150 — GPU, scrollback, image drop, includes `ShellRow` |
| `EditorSection.tsx` | new | 70 |
| `SettingsPanel.tsx` | 1810–2087, 2440–2465 | 200 — chrome, nav rail, routing, Escape |

Single-caller presentational rows (`AgentRow`, `AddAgentForm`, `HookFootprint`, `ProfileRow`, `ShellRow`) live **inside** their section rather than as separate files: none is pure or independently testable, so CLAUDE.md's extraction rule doesn't reach them, and 570 lines is in line with `WorkspaceSettingsDialog.tsx` (515) and `EnvVarsSection.tsx` (495).

**Two reuse cleanups in the same step:**

- The local `fuzzyMatch` at `SettingsPanel.tsx:59–73` is a byte-identical duplicate of the exported one in `src/lib/fuzzyMatch.ts` — delete it, import the real one.
- The bordered `Toggle + 13px title + 11px description` card is duplicated **5×** (lines 2129, 2168, 2296, 1316, 1715) at ~40 lines each; the four new toggles would take it to 9× (~360 lines of identical markup). Extract `ToggleRow({ checked, onChange, label, description, disabled? })` and substitute every existing call site — a DOM-identical swap, so a diff review can confirm no visual change.

**Verify:** `git diff --stat` reads as moves; run the app and click every section — pixel-identical.

## Step 3 — the reorganisation

### Section vocabulary

**Delete `src/stores/settingsUiStore.ts`.** A zustand store in a per-webview JS context can never carry a value written in another webview; it is dead by construction, not merely stale. Replace it with a pure module — CLAUDE.md's own rule, and the repo's convention (`paneTree.ts`, `fuzzyMatch.ts`, `dragPaneHitTest.ts`):

```ts
// src/lib/settingsSections.ts
export const SETTINGS_SECTIONS = [
  "theme", "fonts", "terminal", "editor", "agents", "profiles", "github", "updates",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export const DEFAULT_SECTION: SettingsSection = "theme";

/** Nav groups are presentation only — captions, never addressable. */
export const SETTINGS_NAV: ReadonlyArray<{
  caption: string;
  items: ReadonlyArray<{ id: SettingsSection; label: string }>;
}> = [
  { caption: "Appearance",  items: [{ id: "theme", label: "Theme" }, { id: "fonts", label: "Fonts" }] },
  { caption: "Panes",       items: [{ id: "terminal", label: "Terminal" }, { id: "editor", label: "Editor" }] },
  { caption: "Application", items: [
      { id: "agents", label: "Agents" }, { id: "profiles", label: "Profiles" },
      { id: "github", label: "GitHub" }, { id: "updates", label: "Updates" }] },
];

/** Pre-reorg ids, still reachable from a stale URL. The other five survive verbatim. */
const LEGACY_ALIASES: Record<string, SettingsSection> = {
  "terminal-font": "fonts", "ui-font": "fonts", shell: "terminal",
};

export function normalizeSection(raw: string | null | undefined): SettingsSection | null;
/** `search` is a parameter, not read from `window` — keeps this pure and testable. */
export function initialSection(search: string): SettingsSection;
```

`SettingsPanel`'s local `type Section` (`:42–51`) is deleted; this module is the single source of truth. The rail is rendered by mapping `SETTINGS_NAV`, replacing the eight hand-written `<NavItem>`s at `:2024–2086`.

### Deep-link fix

In `Settings/SettingsPanel.tsx`, resolve the section in a **lazy `useState` initializer** — not a `useEffect`, which would paint Theme for a frame before snapping:

```ts
const [section, setSection] = useState(() => initialSection(window.location.search));
```

Then immediately `history.replaceState` the `section=` param away (keeping `?settings`), so take-once semantics are literal and an HMR reload doesn't snap back. `?settings` is decorative — `main.tsx:31` branches on the window *label*.

Replace the eight-literal `if` chain at `:1836–1846` with `normalizeSection(event.payload)`; an unknown or group-like id returns `null` and the event is ignored. Update the stale doc comment at `window_management.rs:56–59`, which says only the event path sets the section; both are now live. **No functional Rust change.**

### New controls

All use existing setters — `toggleEditorWordWrap`, `toggleMarkdownPreviewAutoOpen`, `setDebugActivityMeter`, `setSkippedUpdateVersion(null)`, `setUpdateSnoozedUntil(null)` (`settingsStore.ts:341, 391, 394, 430–433`). **No new store actions, and no persist version bump** — `version: 8` stays, since no field is renamed, removed or retyped, and all four fields are already in `PERSISTED_DEFAULTS`, `sanitize`, `HARD_DEFAULTS` and `partialize`. A migration would be a no-op forcing every window through `migrate` on next launch.

- **Editor** — "Wrap long lines in the editor"; "Open a preview pane for markdown files"; help text: *Preview colours follow your theme. Switch to printed-paper white from the preview pane's title bar.* Keep the Monaco command in `CodeEditor.tsx:208` and `DiffViewer.tsx:45` — same store, so they stay in sync.
- **Terminal → Diagnostics** — "Show terminal activity meter". Its only consumer is `Terminal/TerminalSlot.tsx:133`, so it belongs where its subject lives. Keep the command-palette toggle as the fast path.
- **Updates → Notifications** — rendered **only** when suppression is active (`skippedUpdateVersion != null`, or `updateSnoozedUntil > Date.now()`). One row reading `Skipping v1.4.2` / `Snoozed until <date>` with a single **"Resume update prompts"** button clearing both. Evaluate the date comparison at render — the section mounts on nav click; don't add a timer.

### Icons

The split saves `TypeIcon`, which the flat-7 design would have deleted. Only `LayoutIcon` is removed, and only **Editor** needs a new glyph.

| Leaf | Icon | Status |
|---|---|---|
| Theme | `PaletteIcon` (`:552`) | kept |
| Fonts | `TypeIcon` (`:574`) | kept |
| Terminal | `TerminalIcon` (`:1371`) | kept |
| Editor | new | **add** |
| Agents / Profiles / Updates / GitHub | `AgentIcon` (`:1077`), `ProfileIcon` (`:1097`), `UpdateIcon` (`:1116`), `PrIcon` (`:1673`) | kept |
| — | `LayoutIcon` (`:594`) | **delete** |

### Anticipated snags

- `AgentsSection`'s effect (old line ~1895) is guarded by `section !== "agents"`. Once it's its own component the guard must be **removed**, not translated — it references a variable that no longer exists. Preserve the deliberate non-reactive `useSettingsStore.getState().agents` read verbatim (see the comment at 1897–1901).
- `handleTerminalFontSizeChange` calls `setAllTerminalsFontSize` from `lib/terminalManager` — it moves into `FontsSection`.
- Nav captions must be non-focusable `<div>`s, not `<button>`s, so Tab order walks exactly the eight leaves.

## Tests

No `@testing-library` is installed; component tests use raw `react-dom/client` + `act` (`src/components/__tests__/OverviewBar.test.tsx`). `SettingsPanel` has zero tests today.

1. **`src/__tests__/settingsSync.test.ts`** (step 1) — as above.
2. **`src/lib/__tests__/settingsSections.test.ts`** (step 3) — pure, no mocks. All 8 ids round-trip; the three legacy aliases (`terminal-font`/`ui-font`→`fonts`, `shell`→`terminal`); the five survivors map to themselves; `normalizeSection("appearance"|"nope"|null|undefined)`→`null` (groups are *not* addressable); **`initialSection("?settings&section=profiles") === "profiles"`** (the regression test for defect 2); `initialSection("?settings")` → `"theme"`. Assert every id in `SETTINGS_NAV` is in `SETTINGS_SECTIONS` and every id in `SETTINGS_SECTIONS` appears exactly once in `SETTINGS_NAV` — so a leaf can't be added to the union and forgotten in the rail.
3. **`src/components/Settings/__tests__/SettingsPanel.test.tsx`** (step 3, optional) — needs `vi.mock("../../../lib/ipc")` for `fonts.listSystemFonts` / `shells.listAvailable` / `agentHooks.status`, plus `@tauri-apps/api/app` and `@tauri-apps/plugin-shell`. Three assertions worth the mocking: three captions and eight leaf items render with expected labels; with `history.replaceState(null,"","?settings&section=profiles")` the Profiles item renders active; captions are not focusable.
4. No new Rust tests — Rust changes are comments only.

## Verification

Per `feedback_verify_runtime_not_just_tests`: green unit tests are not enough — the deep-link and cross-window paths only exist at runtime.

- `pnpm build && pnpm test && pnpm check` green after **each** step, not just at the end.
- `pnpm tauri dev`, Cmd+, — three captions over eight leaves; lands on **Theme**. **Every** control reachable before is still reachable: theme grid, both fonts + both sizes, GPU, scrollback, image drop, shell, hooks, agent list + add custom, profiles, PR polling + interval, update check + auto-check.
- **Rail rendering:** captions read as a distinct, quieter level than the in-page `SectionLabel`s on Terminal and Updates; icon column stays vertically aligned; Tab from the search/first control walks eight rows, skipping captions.
- **Deep-link, closed window:** quit the Settings window → File ▸ Manage Profiles… → must land on **Profiles** (today: Theme). Then reload — must *stay* where the user navigated, not snap back to Theme.
- **Deep-link, open window:** same with Settings already open → Profiles. PR panel's settings link → **GitHub**.
- **Legacy alias:** open with `?settings&section=shell` → lands on **Terminal**; `section=ui-font` → **Fonts**.
- **Cross-window (step 1, retest after step 3):** two Profile-bound windows + Settings. Change shell, word wrap, auto-check and the activity meter → both Profile windows react without relaunch. Toggle the meter from a Profile window's command palette → Settings reflects it.
- **Skip/snooze:** skip a version from the update prompt → the Notifications row appears in Updates → "Resume update prompts" clears it and the row disappears.

## Docs

**No new ADR, and no ADR amendment.** All three criteria fail:
- The denylist doesn't reverse ADR-0008 — it *restores* what its consequences section already describes. The 15-key hand-list was the drift.
- The IA is vocabulary, and cheap to reverse; it belongs in CONTEXT.md.
- ADR-0013's placement decision is honoured, not overturned.

**CONTEXT.md edits:**

- **Line 14 (Settings window)** — enumerate the navigation as three groups over eight canonical sections (*Appearance:* Theme, Fonts · *Panes:* Terminal, Editor · *Application:* Agents, Profiles, GitHub, Updates), and note that the **leaf ids only** are the deep-link vocabulary crossing `open_settings_window { section }` — group captions are presentation and not addressable. Broaden "Theme, font, and agent changes here propagate live…" to state that *every* global setting propagates except a small denied set of drag-derived widths and write-on-use breadcrumbs.
- **Line 14 or 73 (File pane)** — one line: Settings ▸ **Editor** is a UI label covering both **file pane** (`editorWordWrap`) and **preview pane** (`markdownPreviewAutoOpen`) concerns; "Editor" is not a domain term and does not enter the glossary.
- **Lines 113, 116** — qualify **Status Hooks setting** and **Provisioning footprint** as "Settings → Agents".
- **Line 168 (Smart image drop)** — already says "(Terminal section, on by default)", which is wrong today and becomes true here. No edit needed; note in the step 3 commit message that the reorg retroactively makes an existing doc line true.
- **Line 79 (Preview color mode)** — note that Settings ▸ Editor points at the title-bar toggle rather than duplicating it.
