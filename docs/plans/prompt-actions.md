# Prompt actions

One-click, parameterised prompts fired at a running **Agent** from a strip at the bottom of its **Pane**.

Vocabulary lives in `CONTEXT.md` (**Prompt action**, **Action bar**, **Action scope**, **Firing**, **Parameter**, **Toggle parameter**, **Attachment**, **Required**, **Show in bar**, **Palette firing**, **Prompt action store**). Two decisions are recorded as ADRs: attachments travel by path (ADR-0038) and the store is SQLite rather than `settingsStore` (ADR-0039). This document is the build order.

## Shape

A Prompt action is a name, a body with `{{placeholder}}`s, a **scope** (`all` or a set of Agent ids), and a **Show in bar** flag. Its **Parameters** are derived from the body. Firing resolves the body and writes it to the **agent-mode PTY** as one bracketed paste plus a bare `\r`.

Two ways to fire: a button in the **Action bar**, or the **Command palette** targeting the focused pane. Two ways to author: the in-pane popover, or Settings ▸ Prompt actions.

## Status

Built on `feat/prompt-actions`. The build order below was grouped into three commits; the rest of the branch is fixes found by using it and by review.

468 Rust tests, 1714 frontend tests, `tsc --noEmit`, `vite build` and Biome all pass. Every UI change was checked in a browser via `pnpm demo:web`, which now reaches the Settings window through `?window=settings`.

**Outstanding:**

- The last link of the **Waiting** guard needs the running app — see Testing. The seam below it is covered and mutation-checked.
- Dropping the dead `agent_presets_json` column is deferred to a separate fix, at the user's request. The method is written up below.
- Two pre-existing flakes surfaced under full-suite load, both in files this branch does not touch: `settingsRehydrate.test.ts` and `base64.test.ts` ("handles a large payload"). Each passes in isolation and on repeated full runs.

## Commits, in order, on one branch

### 1. Store and IPC

A new `prompt_actions` table, **one row per action** — not a JSON blob in the key-value `settings` table, which would reintroduce the read-modify-write race ADR-0039 exists to prevent. `015_add_prompt_actions.sql` is an additive `CREATE TABLE` with no FK children and no rebuild, so none of the `split_fk_pragmas` hazard applies.

Columns: id, name, body, scope discriminator (`all` | `set`), scoped agent ids, show-in-bar, position, parameter metadata (type, default, and a toggle's on/off text), timestamps. CRUD commands returning `Result<T, AbundioError>`. A `prompt-actions-changed` Tauri broadcast carrying **no payload** — receivers re-read. Name validation in Rust, not only in the UI, following `env_crypto::validate_name`'s precedent.

### 2. Resolution and firing — the pure core

`lib/promptActions.ts`, side-effect-free and unit-testable, mirroring how `fileDrop.ts` is structured:

- derive Parameters from a body (order of first appearance; `{{{{` escapes a literal `{{`)
- resolve a body against parameter values
- **strip C0/C1 from every interpolated value**, reusing `fileDrop`'s `stripControlChars` — a value pasted from a web page can carry `ESC[201~`, which closes bracketed paste early and runs what follows
- **never strip the body**; it is author-written and its newlines are the point
- join multi-file **attachment** paths space-separated, as `buildDropText` does

Firing itself goes through `term.paste()` — the same call `fileDrop` uses, which wraps in `ESC[200~ … ESC[201~` only when the receiving program has the mode on — then a bare `\r`. Alt/Option-click omits the `\r`.

### 3. Action bar

Renders in every **agent mode** pane, including an empty one — where it shows an *Add a prompt action* invitation and drops the trailing `+`. Nothing is seeded, so a bar that hid itself when empty would leave the feature with no visible way in. Global-scoped actions show immediately; agent-scoped ones flow in when `detectedAgentIds[ptyId]` resolves, because a PTY can be in agent mode with no known Agent id (`ptyActivityStore.ts:518-531`).

Order: agent-scoped first, then global, each in authored order (reordering lives in Settings). Horizontal overflow scrolls, vertical wheel mapped to horizontal, fade masks at the live edges, no scrollbar and no arrows. Appear/disappear refits xterm; the space is not reserved.

Buttons carry a **position number** and a name, with a trailing `…` when the action has Parameters, and truncate to a tooltip showing the full name plus a preview of the resolved body. No icons, no per-action colour.

The number is positional — where the button sits in *this* bar — and fires via `Cmd+1`…`Cmd+9` (macOS) or `Ctrl+Shift+1`…`Ctrl+Shift+9` (Windows/Linux), through the existing capture-phase interception. Only the first nine are numbered. `Ctrl+<digit>` is unusable (`Ctrl+3` is ESC) and `Ctrl+Alt+<digit>` is unusable (AltGr on European layouts); `keybindings.ts` currently binds no digits at all.

Buttons disabled while the Agent is **Waiting**, via a pure `canFire(status)` predicate in `promptActions.ts` so the bar and the palette cannot drift apart on the rule.

### 4. Parameter dialog

Opens for any action with one or more Parameters. All fields required, Send disabled until filled, authored defaults pre-filled, **no recall of last-used values**. `text` is one line that grows on Shift+Enter; Enter submits.

### 5. Attachments

`attachment` parameter type. File picker, drag-drop, and Cmd+V. A pasted bitmap is written content-hashed to `app_paths::versioned_root()/prompt-attachments/`. Startup sweep by age. Per ADR-0038 — no clipboard write, no synthesised `Ctrl+V`.

### 6. In-pane popover and the `⋯` entry point

`+` at the bar's right-hand end; **Add prompt action…** in the pane context menu, which is reachable in every Pane and is the *only* entry point before a bar exists. Scope defaults to the pane's Agent (falling back to `all` when the id has not resolved) — slash commands are agent-specific, and defaulting to `all` would put broken buttons in every other Agent's bar. Reorder, duplicate and delete stay in Settings; the popover is deliberately the smaller editor.

### 7. Settings ▸ Prompt actions

New leaf section id `prompt-actions` under the *Application* caption, after *Agents*. No legacy alias needed. `CONTEXT.md`'s "Eight of them" is already updated to nine. Full editor: body, derived parameters with types and defaults, scope, **Show in bar**, reorder, duplicate, delete, and a live preview resolved from defaults.

Separately, a global **Show Action bar** toggle in Settings ▸ Terminal beside `smartImageDrop` — a preference, so it stays in `settingsStore` (ADR-0039).

### 8. Command palette

Entries only while the focused pane is an agent-mode PTY, filtered by scope, ignoring **Show in bar**, disabled while **Waiting**.

## Deferred to a separate fix

### Dropping the dead `agent_presets_json` column

Verified dead against the live database: 28 workspaces, 0 non-empty values. It has been carried since `001_init.sql` and is read by nothing but fixtures. It has to go before "preset" can stop being an ambiguous word.

`015_drop_agent_presets_json.sql` is **one statement**:

```sql
ALTER TABLE workspaces DROP COLUMN agent_presets_json;
```

**Not a table rebuild.** Every other migration here rebuilds, so the file needs a comment saying why this one does not: `workspaces` has two `ON DELETE CASCADE` children — `notes` (`010:6`) and `workspace_env_vars` (`013:9`) — and the `DROP TABLE workspaces` step of a rebuild cascade-deletes every Note and every environment variable in the database. `migrations::split_fk_pragmas` exists to defuse exactly that, and not needing it is better than using it. `rusqlite 0.31` bundles SQLite 3.45; `DROP COLUMN` has existed since 3.35.

Then: `WorkspaceRow` / `WorkspaceUpdate` in `workspace_store.rs`, the three interfaces in `types.ts`, ~15 test fixtures, `demo/fixtures.ts`.

**Back up `abundio.db`, `-wal` and `-shm` before this runs**, and rehearse on a copy of the real database. There are no down-migrations.

**Not part of this branch, by decision.** The word "preset" therefore stays ambiguous until then — `CONTEXT.md`'s **Prompt action** entry says so explicitly, so nothing here reuses the name.

## Deliberately not in v1

- **Save selected terminal text as a Prompt action** from the context menu.
- **Per-Workspace actions.** The motivating case — an action wired to a repo-specific slash command firing in the wrong repo — is deferred to an optional folder condition on an action, keeping one list and one admin surface rather than partitioning the storage.

## Testing

Three layers, with an honest claim about what each buys.

**Pure** (`lib/promptActions.ts`) — derivation, `{{{{` escaping, resolution, attachment joining, and `canFire`. Two tests deserve names rather than being folded into "strips control chars": one asserting a parameter value carrying `ESC[201~` plus a newline is neutered (the `fileDrop.ts:36-47` injection arriving through a new door), and one asserting the **body is not stripped**, so a future tidy-up does not "fix" the asymmetry.

**Component/store** — bar visibility (agent mode ∧ in-scope ∧ non-empty), ordering, position numbering, and the two awkward scope cases: an unresolved Agent id showing global-only, and an emptied scope set rendering nothing.

**Seam** (`firePromptAction.guard.test.ts`) — the Waiting guard against the **real status machine**, not a hand-stubbed state. It drives `ptyActivityStore.applyHookEvent(ptyId, "waiting")` — the same transition a real permission hook causes, through the same reducer — then calls `firePromptAction` and asserts nothing reached the PTY and focus was not stolen. Mutation-checked: disabling the guard fails four of its six cases.

**Runtime** — one link remains, and only the running app can close it: that a real Agent's permission hook *arrives* and produces that transition. That is the hook pipeline (ADR-0015); it predates this feature and is the same signal the status icon has always been driven by, so it is inherited rather than new. The Debug palette entries *Simulate Agent Waiting* / *Clear Agent Waiting* drive the real reducer, so the check is:

1. `pnpm tauri dev`, open a workspace, launch Claude Code in a pane.
2. Author a prompt action so the bar has a button.
3. Ask the agent to do something needing permission, and wait for the status icon to go **Waiting**.
4. The bar's buttons should grey out, and clicking one should do nothing.
5. Answer the permission prompt; the buttons should come back.

Step 3 can be replaced by *Debug: Simulate Agent Waiting* in the command palette to test steps 4–5 alone, which is what the seam test already covers.

## Demo mode

`transcripts.ts` writes transcripts once, immediately, "so screenshots are stable and non-animated", and `mockInvoke.ts:200`'s `pty_write` is a no-op — so without work, a Prompt action button clicks and nothing happens at all.

`pty_write` therefore **echoes** to the pane's output channel, so firing visibly types the resolved prompt into the fake agent. Not a raw echo: strip the `ESC[200~`/`ESC[201~` wrappers and map the trailing `\r` to `\r\n`, or the cursor returns to column zero and the next output overwrites what was just "typed". Note this changes demo typing generally — today typing into a demo pane does nothing — which is an improvement but is broader than this feature.

Attachments cannot work in `demo:web`: a browser `<input type="file">` yields a `File` with no filesystem path, and paths are the whole mechanism (ADR-0038). Attachment parameters render **pre-filled with a canned fixture path**, picker disabled — complete-looking for a screenshot, honest about not working.

## Things that will need care

- **Demo mode fixtures.** `mockInvoke` must serve Prompt action CRUD, and nothing here may reach a Tauri API directly — `demo:web` runs in a plain browser.
- **Refit churn.** The bar appears and disappears on every Agent launch and exit. Worth watching in a short pane.
- **An Agent id that never resolves.** A user-added Agent may never be matched at runtime, so actions scoped to it can be authored and never appear. The editor should say so rather than forbid it.
- **An emptied scope set.** Deleting an Agent can leave an action selecting nothing. Keep it, show it, never render it; deleting is the user's call.
