# Status composite and busy-based close guards

Decision records: ADR-0033 (composite), ADR-0034 (guards). Glossary: **Status composite**, **Primary icon**, **Status badge**, **Busy PTY** in `CONTEXT.md`.

## Goal

Two things, one branch.

**Simplify the status icons.** ADR-0032's two equal rollup icons on every Tab and sidebar row are too much: two marks of identical weight leave the reader working out which one matters. Replace them with one **Status composite** — a 14px **Primary icon** (the Agent rollup when any Agent exists, otherwise the Terminal rollup) with an 8px **Status badge** on its lower-right corner (always the Terminal rollup, and only when it is Error or Working). The underlying model is untouched.

**Make the close guards honest.** Close window and Quit prompt on `openedWorkspaceCount > 0` while claiming "running agents and terminal processes", so they fire on every quit and say something usually untrue. Give them the **Busy PTY** test instead: no busy work, no prompt.

## Decisions worth restating

- **The primary is never displaced.** A shell Error next to an idle Agent is a red badge on a calm green circle, not a red primary. The big icon always answers "what are my Agents doing?".
- **The badge never shows Idle** — but the Terminal rollup does when it *is* the primary. Suppression belongs to the badge, not the rollup.
- **Absent means no PTYs of either kind.** ADR-0032's "absent, not Idle" stands; a never-opened Workspace keeps its grey "Not opened" primary.
- **One tooltip for the whole composite**, one line per present rollup. The only place a Terminal Idle count is always visible.
- **One geometry for both sidebar widths** — they disagree today (12px/3px gap against 14px/4px), and hovering a strip pops the expanded row out on top of it, so the mismatch animates on every hover.
- **Quit is stricter than unload**: Busy *or* a Waiting agent, because quit takes down Windows the user cannot see.
- **A quiet Abundio quits silently.** Scrollback, Windows, Workspaces and layouts all restore; unsaved editor files keep their own separate confirmation.

## Steps (one branch, `feat/status-composite`)

1. **Fold `shellCommandRunning` into the status entry.** Project the reducer field into `PtyActivityEntry`; delete the `isShellCommandRunning` / `setShellCommandRunning` module map and its callers in `terminalManager` and `lib/demo/seed.ts`. Invisible refactor — no behaviour change. The projection's skip-write-when-unchanged comparison must include the new field.
   *Tests*: the projection keeps the flag fresh; the existing guard tests still pass unchanged.

2. **`isBusyPty` + rewire the guards** (ADR-0034).
   - New pure predicate over one `PtyActivityEntry`: Working agent, or shell with a command running.
   - `useConfirmUnloadWorkspace` and `useConfirmCloseTerminalTab` read it instead of the deleted map. The tab guard keeps its own looser "any agent PTY present" rule.
   - `decideWindowClose` takes busy counts instead of `openedWorkspaceCount`; returns "proceed" when nothing is busy.
   - `reportOpenedWorkspaceCount` becomes a `{ working, waiting, commands }` tuple, sent only when the tuple changes. Rust `OpenedCountState` becomes the busy-tuple state; `quit_confirm_message` names what is busy and the quit menu handler skips the dialog at zero.
   *Tests*: `isBusyPty` table over every `(state, detectionMode, shellCommandRunning)`; the Waiting split (excluded for unload/window, included for quit); Rust `quit_confirm_message` cases including the zero case that shows no dialog.

3. **Geometry module + `StatusComposite`** (ADR-0033). One module of constants (primary 14, badge 8, slot width including the badge's outward overhang, left padding, gap), read by `WorkspaceItem` and `CollapsedStrip`. `StatusComposite` replaces `RollupIcon` at call sites: takes both rollups, picks the primary, decides the badge, renders one tooltip. Badge glyph-vs-dot behind a single constant, defaulting to glyph — at 8px a three-stroke breathing chevron may read as mush, and swapping should not touch call sites.
   *Tests*: primary selection (agents present / absent / never-opened / no PTYs at all); badge suppression (Idle, and when terminal is primary); tooltip lines with absent rollups omitted.

4. **Rewire the four call sites.**
   - `WorkspaceItem` left slot: one composite, vertically centred across the name and path lines. On a Worktree set's Primary row the fold chevron replaces the **whole** composite on hover — retiring ADR-0032's "never fully covered" promise, which assumed two icons.
   - `WorkspaceItem` Hidden rollup: composite, then the member count, then the Dirty ring — one line where it used to be two.
   - `CollapsedStrip`: composite at the shared geometry (up from 12px, paid for by the vertical room the stack used); Hidden rollup becomes a `+N` label, neutral grey except for Error / Waiting / Ready, which tint it — the same set that earns an OS notification, so a colour there means "something in here wants you", never "N things are running". Hidden-dirty ring moves to the composite's **top**-right, since bottom-right is now the badge.
   - `TabBar`: one composite before the name.
   *Tests*: update `CollapsedStrip` and `WorkspaceListFolding` suites for the `+N` label and the composite.

5. **Verify in `pnpm demo:web`**: expanded/collapsed alignment with no jump on toggle and on strip hover, folded set, badge legibility at 8px (the glyph-vs-dot call), tooltips. Then in the real app: quit with everything idle (no prompt), quit with an agent waiting (prompt naming it), and a long silent build still counting as busy.

## Out of scope

- Pane close stays unguarded — it already confirms unconditionally.
- The tab guard's looser predicate stays.
- The profile-switch confirmation stays count-based; it is now the only one.
- `OverviewBar` and `StatusBar` are untouched.
- `ptyActivityStore`'s rollup model — `computeWorkspaceRollups`, `computeTabRollups`, `mergeRollups`, the encode/decode keys — is untouched. This is presentation only.
