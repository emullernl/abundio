# Plan: Waiting dialog for worktree create & remove

## Context

Creating a worktree of a large repo briefly freezes the UI after the user clicks **Create**, with no clear feedback. The same blocking work happens on **Remove worktree** (deleting the worktree folder from disk), and today that path gives *zero* feedback and silently swallows failures (`removeWorktreeWorkspace(...).catch(console.error)` in `WorkspaceList.tsx:442`).

**Desired behavior (from the user):** when an operation starts, the source dialog closes and a separate small **waiting dialog** appears ("Creating worktree …" / "Removing worktree …"), which disappears when the operation completes. Cover both create and remove.

The dominant cost is the blocking `libgit2` work in `src-tauri/src/git_libgit2.rs` (`add_worktree` / `remove_worktree`), each run via `spawn_blocking`. For create there's also a short synchronous React mount of the new workspace inside `addWorktreeWorkspace`. The waiting dialog **masks** the perceived freeze — the modal paints during the async git work, and its `terminal-bar-wave` bars keep animating on the compositor even through the synchronous mount (they set `will-change: transform, opacity`, same trick as `SwitchingOverlay`). We are not trying to eliminate the freeze, only to make the wait legible.

## Design decisions (resolved with the user)

- **One shared modal**, `WorktreeProgressDialog`, styled like `ConfirmDialog.tsx`, with two visual states: **progress** (bars + "Creating/Removing worktree <id>…") and **error** (red `AlertTriangle` + message + buttons).
- **Async work lifts up out of the form.** `AddWorktreeDialog` becomes a pure form that hands its values back via `onSubmit`; `WorkspaceList` orchestrates the operation and owns the waiting modal. A new store action `createWorktreeWorkspace` wraps `worktrees.add` + `addWorktreeWorkspace`, mirroring the existing `removeWorktreeWorkspace`.
- **Non-cancelable.** The `libgit2` ops can't be interrupted, so the progress state has no buttons / Esc / backdrop-dismiss. Buttons appear only in the error state.
- **Flicker handling:** the progress state is shown only if the op is still running after **~150ms** (delay-before-show); once shown it stays up a **~400ms** minimum so it never flickers. Small/fast repos show no modal at all.
- **Errors show immediately**, bypassing the 150ms delay and the min-hold. On error the modal enters its error state and waits for the user.
  - **Create error:** buttons **Edit** (reopens `AddWorktreeDialog` pre-filled with the values just entered) and **Close**.
  - **Remove error:** **Close** only; the workspace is still intact (ADR-0017 prunes the folder before tearing down the workspace, so a locked/EBUSY failure is non-destructive).
- **Dialog text:** concise with identifier — `Creating worktree feature/foo…` (branch) and `Removing worktree 'foo'…` (workspace name).
- **No `CONTEXT.md` term and no ADR** — UI affordance, not domain language; reversible polish, no architectural trade-off.

## Changes

### 1. New `src/components/WorktreeProgressDialog.tsx`
Small centered modal (reuse `ConfirmDialog`'s card shell: ~420px, `var(--bg-secondary)`, framer-motion enter/exit, plain `rgba(0,0,0,0.6)` backdrop). Props roughly:
```ts
{ verb: "Creating" | "Removing"; target: string;            // e.g. "feature/foo" / "'foo'"
  status: "progress" | "error"; error?: string;
  onClose?: () => void; onEdit?: () => void; }              // buttons only in error state
```
Progress state renders the 5-bar `terminal-bar-wave` indicator (copy the inline markup from `App.tsx:98–115`, `willChange: "transform, opacity"`) above the message. Error state renders the `ConfirmDialog`-style red icon + message + button row.

### 2. `src/components/AddWorktreeDialog.tsx` → pure form
- Remove `submitting`, the backend-`error` state, and the `worktrees.add` / `addWorktreeWorkspace` calls (lines ~101–102, 139–153). Keep client-side validation and the inline *branch-format* hint (lines 263–267).
- Replace the body of `submit` with `onSubmit({ primaryCwd, branch, absolutePath, agent, setupCommands })` then `onClose()`. Add an `onSubmit` prop.
- Add optional `initialBranch` / `initialFolder` / `initialSelectedIndex` props so **Edit** can reopen with prior values; when `initialFolder` is provided, set `folderDirty.current = true` so the branch→folder auto-derive effect (lines 129–133) doesn't clobber it.

### 3. `src/components/Sidebar/WorkspaceList.tsx` — orchestration
- New state: `worktreeOp` describing the running op (`kind`, `verb`, `target`, plus the create payload retained for **Edit**), and the visual `phase`/`error`, driven by a small reusable hook `useDelayedProgress` (encapsulates the 150ms-show / 400ms-min-hold / show-immediately-on-error timers; unit-testable with fake timers).
- **Create:** `AddWorktreeDialog.onSubmit(payload)` → close form → `runWorktreeOp("Creating", branch, () => createWorktreeWorkspace(payload))`.
- **Remove:** in the existing `ConfirmDialog.onConfirm` (lines 435–443), after closing the confirm, `runWorktreeOp("Removing", name, () => removeWorktreeWorkspace(...))` instead of the fire-and-forget `.catch(console.error)`.
- Render `<WorktreeProgressDialog>` from `worktreeOp`/`phase`. On create-error **Edit**, reopen `AddWorktreeDialog` seeded from the retained payload.

### 4. `src/stores/workspaceStore.ts` — new action
Add `createWorktreeWorkspace(payload)` that awaits `worktrees.add(primaryCwd, branch, absolutePath)` then `addWorktreeWorkspace(entry, setupCommands, agent)` and returns/throws. Keep `addWorktreeWorkspace` and `removeWorktreeWorkspace` as-is (the latter already prunes-then-teardown per ADR-0017). Known edge (documented in code comment): if `worktrees.add` succeeds but `addWorktreeWorkspace` throws, the folder exists on disk and a straight retry from **Edit** would hit "target folder already exists" — rare (local DB insert), surfaced via the error message.

No new dependencies; no Rust changes.

## Verification
- `pnpm tauri dev`. **Create on a large repo:** right-click a main-worktree workspace → "Add worktree…" → branch → Create → form closes, "Creating worktree <branch>…" modal appears with animated bars that keep moving through the mount, then closes onto the new workspace.
- **Create on a tiny repo:** confirm *no* modal flash (finishes under 150ms).
- **Create error:** enter an existing folder → modal shows the error with **Edit** (reopens form, values intact) and **Close**.
- **Remove:** right-click a linked worktree → confirm → "Removing worktree '<name>'…" modal during disk deletion, then it closes and the sidebar switches to the primary. Force a failure (e.g. a busy/locked worktree) → error modal with **Close**, workspace still present.
- Tests: unit-test `useDelayedProgress` (fake timers: no-show under 150ms; min-hold; immediate error). Optional component test for `WorktreeProgressDialog` states. `pnpm check` and `pnpm build` pass.
