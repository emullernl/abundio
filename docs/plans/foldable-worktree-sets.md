# Foldable Worktree sets in the Left sidebar

## Context

A **Worktree set** (ADR-0017) renders in the Left sidebar as one block: the **Primary worktree** row,
then its **Linked worktree** rows indented on a vertical rail (`WorkspaceList.tsx` →
`WorkspaceRowView`). A repo with six worktrees eats six rows and pushes every other Workspace off
screen. The user wants to hide a set's linked rows behind its primary and bring them back on demand.

Grouping itself is derived from git and never stored — this feature adds only a *view* preference on
top of the rows `buildWorkspaceRows()` already produces.

## Language

"Collapsed" was already taken: `windowUiStore.sidebarCollapsed` / `CollapsedStrip` mean *the sidebar
is narrow*. The new state is therefore **folded**, and it is honoured in both sidebar widths. See the
**Folded set** entry in `CONTEXT.md`.

## Decisions

- **Unit** — the whole **Worktree set** folds into its **Primary worktree** row. Only a rendered
  `SetRow` can fold; standalone Workspaces have nothing to hide and get no chevron.
- **Home** — `foldedSetKeys: string[]` in `stores/windowUiStore.ts`, alongside `sidebarCollapsed` and
  `prSectionCollapsed`. Per-**Window**, persisted to `localStorage` under
  `abundio-window-ui-<label>`. No DB migration, no cross-window broadcast: two Windows showing the
  same repository may legitimately disagree about fold state.
- **Key** — the git-derived `worktreeGroupKey` (`SetRow.groupKey`, already the basis of
  `rowId()` → `set:${groupKey}`). It names exactly the block being folded and survives closing and
  re-adding the primary Workspace. A moved repo folder forgets its fold — harmless.
- **A folded set never hides the Active workspace.** Activating a hidden Linked worktree (command
  palette, live-sync, launch restore) removes the key from `foldedSetKeys` and persists that. One
  render mode, no "half-folded" state. In-app **Add worktree** activates the new Workspace
  (`workspaceStore.addWorktreeWorkspace` sets `activeWorkspaceId`), so it unfolds through this same
  rule; a worktree discovered from the CLI is added *unopened* and leaves the set folded.
- **The folded primary carries the hidden rows' signal — the hidden rollup.** Scope is *hidden
  members only*: the row's left status icon keeps describing the Primary, because that is the
  Workspace the row activates. The rollup is a second indicator at the row's right end — one
  `<AgentStatusIcon>` at the highest precedence among hidden members, plus the total hidden count,
  with a tooltip listing each hidden worktree and its state. Extract the existing precedence chain in
  `computeWorkspaceDotStatus` (`error > waiting > ready > active > opened > never-opened`) into a
  shared pure `rollupDotStatus(statuses)` so workspace, tab and set rollups cannot drift.
- **Every state gets a chip, animated like any other status icon.** No static variant, no
  attention-only filter: the chip *is* `<AgentStatusIcon>`, so a folded set answers "is anything
  running in there?" the same way an unfolded one does. Accepted consequence: a folded primary row
  can show two moving icons (its own, and the rollup).
- **Attention does not override the fold.** A hidden worktree reaching waiting or error only recolours
  the chip — no pulse, no auto-unfold. Folding is a view preference the user chose. It changes what
  is drawn, never what is notified: OS notifications from a hidden worktree fire exactly as they do
  today, and that is the channel for "the user isn't looking at the sidebar at all".
- **Control** — a chevron that stops propagation on both `mousedown` and `click`, so it neither
  activates the Workspace nor starts a set drag. Plus a "Fold worktrees" / "Unfold worktrees" item in
  the sidebar context menu for discoverability.
- **Chevron placement: hover-swap the status icon.** The row's left slot is already the status icon
  (`WorkspaceItem.tsx`, `paddingLeft: 8` then `<AgentStatusIcon>`), so there is no free padding to
  overlay. On a set primary, hovering the row cross-fades that 14px box from status icon to chevron.
  Alignment with standalone rows is exact, no column is added, and the status it covers is only
  covered while the pointer is on that row — the rollup chip on the right stays visible throughout.
  Folded-ness is signalled by the missing rows and the chip, not by a permanently visible chevron.
- **Narrow sidebar** — fold applies there too (one fold state, both widths): a folded set renders
  only the primary's `CollapsedStrip`. The strip keeps the primary's own icon and gains a small
  corner badge dot coloured by the rollup state (animated when the rollup is). The existing hover
  popover renders a full `WorkspaceItem`, so it shows the real chip and tooltip. No chevron fits in a
  56px strip, so toggling happens through the strip's existing right-click menu.
- **Key lifecycle: keep, never prune.** Folding only affects a rendered `SetRow`; when the group is
  not a set (last linked worktree removed, primary-less group, or git facts still loading at
  startup) the rows render flat and the key sits inert. If the set re-forms, the fold returns — which
  also makes the async-facts window at launch a non-event. `foldedSetKeys` grows by one path string
  per repository ever folded.
- **Motion** — chevron rotates (~150ms); rows appear and disappear instantly. No height animation:
  the drag hit-test measures block geometry, and animating it would run the drop-slot maths against
  mid-transition rects.
- **No bulk fold-all in v1.** Per-set only.
- **No ADR.** The decision is cheap to reverse (one store field plus a render branch), introduces no
  new source of truth, and rides entirely on ADR-0017's derived grouping. `CONTEXT.md` gains the
  **Folded set** term; that is the whole documentation debt.

## Approach

1. `stores/windowUiStore.ts` — add `foldedSetKeys: string[]`, `toggleSetFolded(key)`,
   `setSetFolded(key, folded)`; add the field to `partialize`. No `version` bump needed (an absent
   key rehydrates as the default `[]`).
2. `stores/ptyActivityStore.ts` — extract `rollupDotStatus(statuses: DotStatus[]): DotStatus` from
   `computeWorkspaceDotStatus`'s precedence chain and reuse it there.
3. `components/Sidebar/WorkspaceList.tsx` — read `foldedSetKeys`; pass `isFolded` + `onToggleFold`
   into `WorkspaceRowView`; skip rendering `row.linked` when folded (both the expanded branch and
   the `collapsed` strip branch). Add the context-menu item, shown only when the target Workspace's
   row is a `SetRow`.
4. `components/Sidebar/WorkspaceItem.tsx` — optional `fold?: { folded, onToggle }` and
   `hidden?: { count, status, members }` props. `fold` turns the left status-icon box into a
   hover-swap target (icon ↔ chevron, ~150ms cross-fade, `stopPropagation` on `mousedown` + `click`);
   `hidden` renders the rollup chip at the row's right end with the members tooltip. Both absent for
   every row that is not a folded set's primary.
   `components/Sidebar/CollapsedStrip.tsx` — same `hidden` prop, rendered as a corner badge dot on
   the strip's status icon.
5. Rollup input — the hidden members' statuses come from the same `useWorkspaceDotStatus` per
   workspace; computing them for hidden rows means keeping those subscriptions alive even though the
   rows are unmounted. Hoist the per-member status read into the set's renderer (a small
   `useSetRollup(row)` hook) rather than mounting hidden `WorkspaceItem`s off-screen.
6. Auto-unfold — in `WorkspaceList`, an effect that clears the key of the set containing
   `activeWorkspaceId` (using `buildWorkspaceRows`' output, so it can never disagree with what is
   rendered).

## Tests

- `windowUiStore`: toggle is idempotent per key; persistence round-trip.
- `rollupDotStatus`: precedence order; empty input; agrees with `computeWorkspaceDotStatus` on the
  single-member case.
- Rollup covers hidden members only: a primary in `error` with all-idle hidden members shows a red
  left icon and a green/grey chip, not a red chip.
- A hidden member's status change updates the chip while its row is unmounted (the subscription
  survives folding).
- `WorkspaceList` (jsdom): folded set hides linked rows and shows the count; chevron click does not
  call `beginWorkspaceSwitch`; activating a hidden member unfolds; a stale key for a group that is
  no longer a set renders flat without throwing; fold survives the narrow/wide sidebar toggle.
