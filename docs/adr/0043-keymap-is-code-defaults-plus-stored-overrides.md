# The Keymap is code defaults plus stored Overrides

Users can rebind or unbind every app **Shortcut** and every labelled Monaco action in **Settings ▸ Keyboard** (#202). The built-in defaults carry careful per-platform reasoning (see the comments in `lib/keybindings.ts`) and will keep changing between releases.

We store **only the user's Overrides** — a **Chord**, or `null` for **Unbound** — in `settingsStore.keybindingOverrides`, keyed `app:<KeyAction>` or `editor:<monaco action id>`. The defaults stay in code. The effective **Keymap** is the defaults with the Overrides applied, rebuilt whenever the Overrides change. Overrides ride the existing `settings-store-changed` broadcast (ADR-0008), so a rebind reaches every Window without a restart.

## Considered options

- **Save the whole keymap.** Simple to read back, but it freezes the defaults: a default fixed in a later release would never reach anyone who had once opened the page. Rejected.
- **SQLite with IPC.** Right for content that many surfaces write often (ADR-0039). A keymap is a preference written rarely from one page; a migration and new commands would be pure cost. Rejected.
- **Store Overrides in `settingsStore`.** Chosen.

## Decisions that follow

- **One Chord per Shortcut, no sequences.** Rebinding a Monaco action with several defaults removes all of them (a `-<id>` rule with keybinding 0) and adds the one new Chord.
- **Monaco's action list is read at runtime** in the Settings window: opening the Editor group loads Monaco from the CDN, creates an offscreen editor and reads `getSupportedActions()` plus each action's default through the editor's keybinding service (an internal API, guarded). A checked-in list would drift, because the Monaco actually served is pinned by `@monaco-editor/loader`, not by `package.json`. The cost: the Editor group needs a network connection the first time. The App group never does.
- **Open settings is the only Shortcut synced to the native menu.** Its Chord is sent to Rust (`set_settings_accelerator`), which rebuilds the menu, so the Settings… item shows the chord that works and a rebind frees Cmd+,. The other menu chords (Quit, Hide, Minimize, the Edit menu's undo/cut/copy/paste/select all) are **reserved**: recording one is refused. Rust validates the accelerator string at the IPC boundary, since an invalid one would make `build_menu` fail and leave the menu stale.
- **Conflicts.** Within one scope (app↔app, editor↔editor) a shared Chord silently disables one action, so the page asks: Reassign (the other becomes Unbound) or Cancel. Between a workspace-global app action and an editor action the Chord is allowed with a warning, since the app wins while the editor has focus.
- **`keybindings.ts` never imports the store.** `App.tsx` pushes the Overrides in, in the spirit of the `terminalSettingsBridge` rule.

## Consequences

- The stored format and its namespaced ids are hard to change later. An Override for an action or Monaco id that no longer exists is ignored and kept, which is harmless.
- Behaviour that is special-cased in `handleKeyDown` is keyed by action id, so it follows a rebind: save-file still passes through to terminals, copy/paste still defer to text fields, the Fleet gates still apply.
- Deferred, and not blocked by the format: import/export, per-Profile keymaps, presets, two-step chords.
