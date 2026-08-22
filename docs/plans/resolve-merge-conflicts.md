# Resolve merge conflicts in Abundio

## Context

When a `git merge` or `git rebase` stops on a conflict, Abundio is blind to it. Nothing in the
codebase knows what an unmerged path is:

- `git_libgit2.rs::compute_changed_files_sync` emits four sections — `against_base`, `staged`,
  `unstaged`, `untracked`. None is "conflicted".
- `blob_string_at_index` (`git_libgit2.rs:430`) reads **index stage 0 only**. A conflicted path has
  no stage 0, so it returns `None` → empty string. Clicking a conflicted file today gives an empty
  original diffed against the whole marker-laden file.
- `GitChangesFileItem`'s `STATUS_COLORS` / `STATUS_LABELS` have no `"U"` entry, so an unmerged file
  renders as a bare grey letter.
- `repo.state()` is never called anywhere, so Abundio cannot tell that an operation is in progress.

So the user drops to a terminal, hand-edits markers elsewhere, and comes back.

**Goal:** resolve conflicts inside Abundio — see them listed, fix them in the editor with per-block
accept actions, and stage the result.

**Scope:** manual three-way resolution, no AI. **Read + stage only** — Abundio's single write to git
is `git add`. `merge --continue`, `rebase --continue` and `--abort` stay in the terminal, where the
user can see git's own output.

## Design decisions

Eight decisions, each settled in review. The reasoning matters more than the conclusion — most of
these look arbitrary without it.

**1. `git add` is allowed; the never-write-the-index rule was only ever about snapshotting.**
`CONTEXT.md:229`, ADR-0021 and the `Safety:` comment on `snapshot_worktree_tree`
(`git_libgit2.rs:197-204`) all promise the on-disk staging area is never touched. Read strictly,
all three are scoped to the snapshot path — but the property is currently globally true by accident,
and the next reader will treat it as a rule. The protection that actually matters is against
**invisible side effects**: telemetry silently restaging the user's work is a bug; a button the user
clicked is the opposite. So the invariant is **reworded, not deleted**:

> Abundio writes the git index only on explicit user action — never as a side effect of telemetry,
> polling, or rendering.

That is a stronger and more portable promise than the one it replaces, and it keeps ADR-0021's real
guarantee intact. `git add` is also the one git write that cannot lose work: additive, reversible
with `git restore --staged`, and exactly what git tells you to run when it stops.

**2. A conflicted row's click opens the text pane, and the row drops its "Open File" button.**
Everywhere else in the Git changes tab, clicking a row opens a **diff pane** and a hover-revealed
nested button opens the **text pane** — the pairing `CONTEXT.md:78` cites as its example of
`path` vs `diff:path` panes coexisting. Conflicted rows invert it. An `against_base` row is
something you're *reviewing*, so a diff is the right primary; a conflicted row is **blocking you**,
and there is exactly one thing you want to do with it. Making that the hover-only affordance gets
the priority backwards. There is precedent for the row varying: `isDeleted` already suppresses the
nested button.

Consequence: the per-block `Compare` code lens is **dropped** — it had no coherent implementation (a
diff editor nested inside a lens is not a thing), and decision 9 supersedes it with something
better. The `"conflicted"` arm of `git_file_diff` stays, as a defensive fallback only.

**3. A conflicted file appears in *both* Conflicted and Against-base. That is not a duplicate.**
The four existing sections are not peers — they are a pipeline of endpoint pairs:
`untracked` → `unstaged` (index vs worktree) → `staged` (HEAD vs index) → `against_base`
(merge-base..HEAD, committed history only). "Conflicted" is not a fifth stop; it is a **state that
suspends the pipeline**. A conflicted file has no honest staged/unstaged entry — there is no stage 0
to diff — so dedup it out of those three. But `against_base` reads *committed history* on a
different axis: if the file dropped out of it, your branch review would silently shrink mid-merge
and grow back afterwards, for reasons unrelated to your branch. The two rows behave differently when
clicked (decision 2), which is what stops the double-listing from reading as a bug.

**4. User-visible text never names a side.** During a **rebase**, git replays your commits onto
upstream, so stage 2 ("ours") is the *upstream* side and stage 3 ("theirs") is **your own commit**.
Any UI sentence of the form "deleted by them" is therefore backwards half the time — and these are
precisely the marker-less files, so there are no marker labels to read instead. Fixing it properly
would need rebase detection just to phrase a sentence. Instead the copy is structural:

> "This file was changed on one side of the merge and deleted on the other."

It cannot be backwards because it makes no claim. The vocabulary boundary is the **IPC layer**:
Rust sits on the index and speaks git's own language (`ours` / `theirs`, `deleted_by_us`), the UI
speaks the markers' language (**Current side** / **Incoming side**). Because the UI names no side,
`deleted_by_us` and `deleted_by_them` render identically, so the six-way `kind` collapses to three
UI cases and becomes a pure discriminator.

**5. The Git changes tab shows one line when an operation is in progress.** Originally cut as scope
creep; reinstated. Follow the flow: you stage the last conflict, the Conflicted section empties and
disappears, you close the pane — and Abundio's state is now **indistinguishable from "you have
staged changes"**. For a merge that's survivable (`git commit` completes it). For a **rebase** it is
not — `git commit` there leaves a stray commit and a still-stopped rebase. A design that
deliberately stops short has an obligation to say where it stopped. It is also read-only, so it
widens "read + stage only" by nothing. **No Abort/Continue buttons, no progress counter.**

**6. Detect it with `repo.state()`, and fix the watcher's linked-worktree blind spot.**
`Path::exists(".git/MERGE_HEAD")` is wrong for a **Linked worktree**, whose real gitdir is
`<repo>/.git/worktrees/<name>/`. `repo.state()` is worktree-correct for free (`open_repo` uses
`Repository::discover`) and distinguishes `RebaseInteractive` / `RebaseMerge` / `RevertSequence`.

The watcher has the matching bug: `file_watcher.rs:102` watches the **workspace folder**, and
`is_meaningful_git_change` matches the substring `".git/MERGE_HEAD"`, which never appears in
`.git/worktrees/feat-x/MERGE_HEAD`. Usually masked, because `git merge` writes markers into watched
files — except in the one flow this feature creates: resolve and stage everything in Abundio, then
run `git merge --continue` in a terminal. That writes a commit and deletes `MERGE_HEAD` while
**changing no file in the workspace folder**, so the new line would stay on screen forever in a
Linked worktree. A stale signal is worse than none: a missing signal makes you check `git status`;
a wrong one makes you trust the app. Pre-existing bug, first depended on here.

**7. Rendering is derived from text; writing is derived from the index.** The toolbar must *not* key
off "the buffer has markers". In this app the likeliest workflow is asking the agent in the next
pane to resolve it — after which the markers are gone but the path is **still unmerged** (stages
1/2/3 intact, no stage 0, git still refuses to continue). Under a marker-based rule the staging
button vanishes exactly when it is needed, in the scenario Abundio exists to serve. So:

- **Toolbar visibility ← the index** (the path is unmerged). Survives anyone else doing the work.
- **Decorations and lenses ← the buffer.** Pure text derivation; they still work on any file
  containing markers, unmerged or not.
- **Toolbar mode ← the intersection.**

This also demotes `N = 0` from a gate on the *button* to a gate on the *count*. Git lets you stage a
file with markers still in it, and occasionally that is deliberate; Abundio should not be stricter
than git without a reason it can state.

**8. Per-workspace conflict state lives in `workspaceGitStore`.** `useGitChangesStore` is a singleton
mirroring only the **Active workspace**, and per ADR-0002 background workspaces stay *mounted*
(`visibility: hidden`), so a conflict pane in workspace B would read A's conflicted set and flip its
toolbar on every switch. `workspaceGitStore` is already keyed `byWorkspaceId`, already reactive, and
`applyBundle` already writes it for every workspace for the sidebar chips. Hidden panes are live —
they hold state and respond to watcher events — so they get correct data, not a visibility guard.

**9. A 3-pane Merge view, built from Abundio's own pane tree — not VS Code's merge editor.**
VS Code's merge editor cannot be reused: there are **zero** files matching `*merge*` in the entire
`monaco-editor` ESM tree (the four shipped widgets are `codeEditor`, `diffEditor`,
`markdownRenderer`, `multiDiffEditor`). It lives in `vs/workbench/contrib/mergeEditor/` — the
*workbench* — wired into instantiation services, context keys and observables that the standalone
distribution does not have. Porting it means porting a slice of the workbench.

But the expensive half of a merge editor is **already done, by git**. VS Code has to *compute* its
result document — auto-merging the non-conflicting changes and marking the rest. The conflicted
working-tree file already **is** that document. So a Merge view reduces to: the result pane this
plan already builds, plus read-only side panes fed by `git_conflict_file`, which this plan already
builds. Nothing in decisions 1–8 is wasted or reworked; the Merge view is strictly additive.

Abundio also already has the exact primitive. ADR-0001 established
`{ type: "preview"; id; sourcePaneId }` — a derived, read-only pane owning no file, bound to a
**source pane**, auto-opened beside it, pruned when orphaned. A **Merge side pane** is the same
shape, and `paneTree.ts` already ships `findPreviewForSource`, `findOrphanPreviews`,
`pruneOrphanPreviews`, `wrapInSplit` and `insertBesideNode` to generalise.

Layout mirrors VS Code: **Current | Incoming** across the top, result below, **Base hidden by
default** and toggleable (and unavailable when stage 1 is absent, i.e. `both_added`).

**Crucially, no `loader.config({ monaco })` is required.** I expected to need
`defaultLinesDiffComputer` to map conflict block *N* onto line ranges in each side document. It is
avoidable: the marker block's current-side text is a **verbatim slice of the ours document**, so a
**monotonic forward search** — process blocks in order, `indexOf(sideText, cursor)`, advance the
cursor past each match — resolves all of them deterministically, handles repeated text, and needs no
diff library. If a match fails, that block simply gets no side highlight. This keeps us off deep
monaco imports entirely (see below), so the CDN-loader constraint stands unchallenged.

**Also settled:** no `loader.config({ monaco })` exists in this repo, so `@monaco-editor/react`
loads monaco from jsdelivr at runtime. Never `import` from `monaco-editor/esm/vs/...` — Vite would
bundle a second copy with a different model registry and `Emitter` class. Only use the `m: Monaco`
from `onMount`; type-only imports are fine and are the house pattern. (This also means the editor
does not work offline today — a real pre-existing bug, deliberately **not** in scope here.)

**And:** `.git/index` is deliberately excluded from `is_meaningful_git_change` (`file_watcher.rs:41-44`
— read-only git commands touch it), so the scheduler will **not** observe `git add`. The stage
handler must call `fetchChanges` itself. Do not add `.git/index` to the meaningful set.

## Implementation

Single branch `feature/resolve-merge-conflicts`, ordered commits.

### 1. `src-tauri/src/git_commands.rs` — shared path validator

Extract the relative-path / no-`..` check inlined in `git_file_diff` (`:196-203`) into
`fn validate_repo_relative(file_path: &str) -> Result<(), AbundioError>`. Use it in `git_file_diff`
and both new commands. A command that *writes* must not carry its own copy.

### 2. `src-tauri/src/git_libgit2.rs` — conflicted section + operation state

`fn conflicted_files(repo: &Repository) -> Vec<GitChangedFile>` sourced from
**`repo.index()?.conflicts()`** (yields `IndexConflict { ancestor, our, their }`), not a
`Status::CONFLICTED` walk — O(conflicts) against an already-open index. Emit `status: "U"`,
`additions: 0, deletions: 0`; there is no honest numstat for an unmerged path.

In `compute_changed_files_sync` (`:162`), per decision 3:
- `conflicted` goes **first**, ahead of `against_base`.
- Collect conflicted paths into a `HashSet<String>` and `retain` them out of `staged`, `unstaged`,
  `untracked`. Don't trust libgit2 to omit conflicts from `diff_tree_to_index` /
  `diff_index_to_workdir` — behaviour varies by API and version, and a duplicate row only surfaces
  mid-merge.
- **Keep** the path in `against_base`. Pin both halves with tests.

`fn operation_in_progress(repo: &Repository) -> Option<&'static str>` mapping `repo.state()`:
`Merge → "merge"`; `Rebase | RebaseInteractive | RebaseMerge → "rebase"`;
`CherryPick | CherryPickSequence → "cherry_pick"`; `Revert | RevertSequence → "revert"`;
`Clean` and the rest → `None`. Add it to `GitFetchBundle` as `operation_in_progress: Option<String>`.

`fn blob_string_at_stage(repo, path, stage: u16)` beside `blob_string_at_index`, plus a doc line on
the latter noting stage 0 is intentional there.

No new field on `GitChangedFile`, so `filesEqual` (`gitChangesStore.ts:52`) needs no change — it
already compares `section`, so `unstaged → conflicted → staged` re-renders for free.

### 3. `src-tauri/src/file_watcher.rs` — see linked worktrees (decision 6)

- At watch setup (`:102`), resolve the gitdir once via `Repository::discover(root_path).path()`.
  If it is not under `root_path`, add a second `.watch()` on it to the same `RecommendedWatcher`.
- Widen `is_meaningful_git_change` (`:45`) to match the trailing filename (`/MERGE_HEAD`,
  `/REBASE_HEAD`, `/CHERRY_PICK_HEAD`) rather than the `.git/`-prefixed substring, so
  `.git/worktrees/<name>/MERGE_HEAD` matches. Leave the `.git/index` exclusion exactly as is.
- Note in the commit message that this is a pre-existing Linked-worktree bug, not new scope.

### 4. `src-tauri/src/git_commands.rs` — two new commands

```rust
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct GitConflictFile {
    pub file_path: String,
    pub kind: String,          // both_modified | deleted_by_us | deleted_by_them
                               // | both_added | added_by_us | added_by_them
    pub is_binary: bool,
    pub base: Option<String>, pub ours: Option<String>, pub theirs: Option<String>,
}
pub async fn git_conflict_file(cwd: String, file_path: String) -> Result<GitConflictFile, AbundioError>
pub async fn git_stage_path(cwd: String, file_path: String) -> Result<(), AbundioError>
```

`kind` derives purely from which stages exist (1=ancestor, 2=ours, 3=theirs). `is_binary` = any
present stage returns `Blob::is_binary()`; when true all three text fields are `None`.
Rust keeps git's own `ours`/`theirs` vocabulary — the UI translates (decision 4).

**No merged text in the return** — the pane owns that buffer via `fs.readFile`, and a second copy
would immediately diverge. **No side labels** — the markers carry them, and Rust would get rebase
backwards.

`git_stage_path` has `git add -A <path>` semantics: validate → open index → `index.add_path` if the
file exists on disk, else `index.remove_path` → `index.write()`. `git_index_add_bypath` on a
conflicted path drops stages 1/2/3 and writes stage 0, resolving it. The missing-file branch makes
delete-conflicts free: `fs_delete` (already registered) then `git_stage_path`.

Doc-comment it as **the only place in the codebase that writes the on-disk index**, and amend the
`Safety:` comment on `snapshot_worktree_tree` (`git_libgit2.rs:197-204`) to name this exception and
restate the invariant per decision 1.

Add the `"conflicted"` arm to `git_file_diff`'s section match, returning ours-as-original /
theirs-as-modified — this backs **Compare sides** (decision 2).

Register all three in `src-tauri/src/lib.rs` (~:957); add `git.conflictFile` / `git.stagePath` to
`src/lib/ipc.ts` (~:232-345) and `operationInProgress` to the `GitFetchBundle` type.

### 5. Frontend wiring for the section

- `src/lib/types.ts:208` — widen to
  `"against_base" | "staged" | "unstaged" | "untracked" | "conflicted"`. Also fixes a pre-existing
  bug: the backend already emits `"untracked"`, and `PaneNode.diffSection` is typed off this union.
- `src/components/GitChanges/GitChangesFileList.tsx:14-22` — `SECTION_ORDER` gains
  `{ key: "conflicted", label: () => "Conflicted" }` **first**.
- `src/components/GitChanges/GitChangesFileItem.tsx:11-25` — `STATUS_COLORS` / `STATUS_LABELS` gain
  `U` (`var(--error)`); suppress the nested "Open File" button for conflicted rows, reusing the
  `isDeleted` spacer branch (`:117`).
- `src/components/RightSidebar/GitChangesTab.tsx:36` — early-branch in `handleSelectFile`:
  `if (file.section === "conflicted") { handleOpenFile(file); return; }`. **Must ship in the same
  commit as the section**, or a click calls `git_file_diff` with an unknown section.
- Same file — render the operation-in-progress line above the sections when non-null:
  *"Merge in progress — finish with `git merge --continue`"* and the `rebase` / `cherry-pick` /
  `revert` variants. One line, no controls.
- `src/stores/workspaceGitStore.ts` — add `conflictedPaths: string[]` to `WorkspaceGitInfo` (`:9`),
  populated in `applyBundle` for **every** workspace alongside the existing chip counts (decision 8).
- `src/stores/gitChangesStore.ts` — carry `operationInProgress` through `applyBundle` and the cache
  entry.

### 6. `src/lib/conflictMarkers.ts` — the parser (pure, no imports)

```ts
export interface ConflictSide  { startLine; endLine; startOffset; endOffset; label: string }
export interface ConflictBlock {
  index: number; startLine; endLine; startOffset; endOffset;
  current: ConflictSide; base: ConflictSide | null; incoming: ConflictSide;
}
export function parseConflicts(text: string): ConflictBlock[];
export function resolveBlock(text, block, choice: "current"|"incoming"|"both"|"base"): string;
```

- **Marker recognition matches git's own rule exactly**: seven of the character at column 0 followed
  by a space or EOL — `/^<{7}(?: |$)/`, `/^\|{7}(?: |$)/`, `/^={7}$/`, `/^>{7}(?: |$)/`. That is the
  answer to "markers inside string literals": git uses this same rule when it writes the file, so
  such a file is *already* broken for git. Being cleverer would make the two disagree about what is
  conflicted. Put that reasoning in a comment — someone will want to "improve" it.
- **Line state machine**, not a global regex: `none → current → base? → incoming`. On an unexpected
  marker or EOF mid-block, abandon the in-progress block **without emitting it** and re-process the
  offending line in state `none`. Malformed and nested regions therefore yield zero lenses and zero
  decorations, and `resolveBlock` can never splice a half-parsed range. Never throws.
- **Carry char offsets alongside line numbers**; `resolveBlock` splices the original string by
  offset — never split/rejoin an array. CRLF, mixed EOL and a missing final terminator are then
  preserved byte-for-byte with no special-casing.
- `"both"` keeps current-then-incoming order and drops every marker line. `"base"` only when
  `block.base !== null` (diff3/zdiff3).

### 7. `src/lib/conflictLenses.ts` + `CodeEditor.tsx` — inline decorations and lenses

A **single, module-level, register-once** CodeLens provider with a
`Map<modelUriString, ConflictBlock[]>` registry:

- Selector `"*"` (per-language would miss unknown extensions). `provideCodeLenses` does one Map
  lookup and returns `{ lenses: [], dispose(){} }` for every other editor in the app.
- **The provider must expose `onDidChange`** (`new m.Emitter<languages.CodeLensProvider>().event`)
  and fire it whenever the registry changes. Miss this and Monaco caches — lenses go stale after the
  first resolution. The single most likely thing to look "broken".
- Register lazily from the `m: Monaco` in `onMount`, guarded by a module boolean, mirroring
  `apexRegistered` / `astroRegistered` in `monacoShared.ts`. Never dispose.
- **Three** lens commands per block — Accept Current / Accept Incoming / Accept Both (Compare was
  dropped, decision 2) — via `ed.addCommand(0, handler)`, block index passed as lens `arguments`,
  stored in a `Map<tabId, …>` beside the existing `liveEditors`. Prefer this over
  `monaco.editor.registerCommand`, which is not reliably in the 0.55 public typings.
- Decorations via `ed.createDecorationsCollection([])` on mount, `.set(...)` after each parse — not
  the deprecated `deltaDecorations`. Whole-line classNames for current / incoming / ancestor plus a
  glyph on marker lines; enable `glyphMargin` through `ed.updateOptions()` only while the pane has
  blocks, leaving `editorOptions` (`CodeEditor.tsx:265-290`) alone for the common case.
- **Colours as CSS classes reading `var(--success)` / `var(--accent)` / `var(--error)` via
  `color-mix`**, not Monaco theme colours — classNames follow a theme change for free, whereas theme
  colours need `defineAbundioTheme` re-run (and it early-returns on an unchanged `themeKey`).
- **Apply with `ed.executeEdits("abundio.conflict", [...])`, never `setValue`.** The controlled
  `value` prop reconciles a mismatch via `model.setValue()`, which destroys the undo stack and
  cursor. `executeEdits` keeps Cmd+Z working and its `onChange` reaches `updateFileContent` on its
  own.
- Re-parse via `useMemo(() => parseConflicts(content), [content])` in a `useConflictDecorations`
  hook. No debounce initially — `updateFileContent` already re-renders per keystroke, so the parser
  adds one O(lines) scan to a path that is already O(document). Debounce only the decoration/lens
  push, and only if profiling shows jank.

Decorations render on **any** buffer with markers, unmerged or not (decision 7).

### 8. `src/components/FileViewer/ConflictToolbar.tsx` + `FilePane.tsx`

`FilePane` renders the toolbar above `<CodeEditor>` in the `fileType === "text"` branch (`:313-322`),
below `FileChangeBanner`, same `flexShrink: 0` slot, **when the pane's path is in
`workspaceGitStore.byWorkspaceId[workspaceId].conflictedPaths`** — not when markers are present
(decision 7).

Mode is chosen by intersecting that with the parse result:

- **Markers present** → `N conflicts remaining`, `Accept all current` / `Accept all incoming`
  (applying `resolveBlock` right-to-left over the block list — descending offsets keep earlier
  offsets valid — in one `executeEdits`), **Merge view** (toggle, §10), and **Resolve & stage**.
- **No markers, still unmerged** → *"No conflict markers left — save and stage when you're ready."*
  plus **Resolve & stage**. This is the agent-resolved case.
- **Marker-less by nature** (delete conflicts) → *"This file was changed on one side of the merge and
  deleted on the other."* with **Keep the file** (`git.stagePath`) and **Delete the file**
  (`fs.delete` then `git.stagePath`). Names no side (decision 4).
- **Binary** → *"Binary conflict — resolve in a terminal."* No buttons. Explicit MVP exclusion:
  choosing a side means writing a blob to the worktree, beyond "save the buffer, `git add`".

**Resolve & stage** is enabled whenever the path is unmerged — *not* gated on `N = 0` (decision 7).
Handler: `saveFile(paneId)` → `git.stagePath(cwd, relPath)` → **forced**
`fetchChanges(cwd, baseBranch)` (the scheduler cannot see the index write) → replace the toolbar
with a static line: *"Staged. Finish the merge with `git merge --continue` in a terminal."*

### 9. The Merge view (decision 9)

Modelled directly on the markdown-preview machinery, which is the same architecture.

**`src/lib/types.ts`** — new `PaneNode` variant beside `preview`:

```ts
| { type: "mergeSide"; id: string; sourcePaneId: string; side: "current" | "incoming" | "base" }
```

**`src/lib/paneTree.ts`** — generalise the three preview helpers to any pane carrying a
`sourcePaneId`, so both variants share one implementation:
`findDerivedForSource(tree, sourceId, type)`, `findOrphanDerived`, `pruneOrphanDerived`. Keep the
existing `findPreviewForSource` / `pruneOrphanPreviews` names as thin wrappers so
`markdownPreview.ts` and `workspaceStore.ts:308` don't churn. Extend `collectPaneIds` (`:133`).

**`src/lib/mergeView.ts`** (new) — a near-copy of `markdownPreview.ts`'s shape:

- `makeMergeSideNode(sourcePaneId, side)`.
- `toggleMergeViewForPane(paneId)` — resolves a side pane back to its source exactly as
  `toggleMarkdownPreviewForPane` does (`markdownPreview.ts:78`), then builds or removes the layout.
  Uses `wrapInSplit` (`paneTree.ts:171`).
- Layout: outer `direction: "horizontal"` (stacked — sides above result, `ratio: 0.45`), inner
  `direction: "vertical"` (side by side). Note the naming: `buildFilePaneLayout` places the preview
  *beside* the file with `direction: "vertical"`, so **vertical = side-by-side divider**.
- `toggleMergeBase(paneId)` — adds/removes the third side pane. No-op when `kind === "both_added"`
  (no stage 1).
- `pruneResolvedMergeSides(tree, conflictedPaths)` — mirrors `pruneNonMarkdownPreviews`
  (`markdownPreview.ts:100`): drop side panes whose source path is no longer unmerged, so finishing
  or aborting a merge tears the view down on its own (consistent with decision 7 — index-derived).

**`src/components/Terminal/SplitContainer.tsx`** — add `if (node.type === "mergeSide") return
<MergeSideLeaf node={node} />` beside the `preview` branch (`:156`). Unknown types already fall
through to `UnknownPaneFallback` (`:163`), so an older build reading a newer layout renders a
placeholder rather than crashing.

**`src/components/FileViewer/MergeSidePane.tsx`** (new) — a titled, read-only pane. Resolves its
source pane's file path, fetches `git.conflictFile(cwd, relPath)` **once per source pane** (cache it
alongside the toolbar's existing fetch — one call serves the toolbar and all three sides), and
renders the matching stage. Title bar reads `Current` / `Incoming` / `Base` — never
ours/theirs (decision 4).

**`src/components/FileViewer/CodeEditor.tsx`** — add `readOnly?: boolean` to `CodeEditorProps`
(`:11`), threaded into `editorOptions`. Note the module maps (`stateCache`, `liveEditors`) are keyed
by the `tabId` prop, which `FilePane.tsx:314` actually passes as **`paneId`** — so three extra
editors in one tab do *not* collide. Worth renaming the prop to `paneId` in passing; it currently
lies about what it holds.

**Block ↔ side mapping** — `src/lib/conflictMarkers.ts` gains a pure companion:

```ts
export function mapBlocksToSide(
  blocks: ConflictBlock[], sideText: string, pick: (b: ConflictBlock) => ConflictSide,
): Array<{ startLine: number; endLine: number } | null>;
```

Monotonic forward search per decision 9 — `indexOf` from a cursor that advances past each match,
`null` when a block can't be located. Pure, fully unit-testable, no monaco and no diff library.

**Highlight and reveal** — `src/lib/scrollSync.ts` (already keyed by paneId) gains an
editor↔editor path beside its existing editor↔HTML-preview one. Driven **one-directionally**: the
result pane's cursor position selects the active block, and each side pane does
`revealRangeInCenter` plus a whole-line highlight decoration over its mapped range. Sides never
drive the result — simpler, and matches how the view is actually used.

Side panes are **read-only context**. All accept actions stay in the result pane, where the buffer
and the dirty state live. This is a deliberate reduction from VS Code, whose per-side checkboxes
duplicate what our lenses already do.

### 10. Docs

- `docs/plans/resolve-merge-conflicts.md` — house structure, first commit.
- `docs/adr/0029-conflict-resolution-happens-in-a-text-pane.md`, `status: accepted`, written last.
  **Decision**: a conflicted file is resolved in an ordinary editable **file pane** driven by the
  working tree's own markers — not a merge pane, not a diff pane — and Abundio's only write to git
  is `git add`. One-line summary for the opening paragraph: **rendering is derived from the text,
  writing is derived from the index.**
  **Why this shape**: the standalone Monaco distribution ships no merge-editor widget; the conflicted
  working file already *is* the three-way merge, so an inline UI needs a parser and a splice where a
  two-pane UI would need a merge *serializer*; keeping `fileType` at four values leaves `saveFile`,
  `handleFsChange`, `reloadPaneFromDisk` and tab persistence untouched.
  **Consequences**: the index is written for the first time, and the ADR-0021 invariant is reworded
  to "only on explicit user action" rather than dropped; the Conflicted section's rows open a text
  pane, unlike every other section; a conflicted file is listed twice, on two different axes; binary
  conflicts are excluded; finishing the operation stays in the terminal; the CodeLens provider is
  global, scoped per model by URI; conflict state is read from the index, so an agent that resolves
  the markers does not remove the staging button.
- `docs/adr/0030-merge-side-panes-are-derived-panenodes.md`, `status: accepted`. Separable from 0029
  and deserves its own record because it adds a **persisted** node shape.
  **Decision**: the Merge view is composed from Abundio's own pane tree — a new
  `{ type: "mergeSide"; id; sourcePaneId; side }` `PaneNode`, read-only, bound to a source pane —
  rather than a merge-editor widget. **Why this shape**: VS Code's merge editor is workbench code,
  absent from the standalone monaco distribution and not portable; and its expensive half, computing
  the result document, is already done by git, whose conflicted working file *is* that document.
  This deliberately echoes ADR-0001, whose reasoning for `preview` applies unchanged — a side pane
  isn't "a file open here", and it must reflect the source's live buffer.
  **Consequences**: the layout JSON gains a second derived node shape, and orphan pruning
  (`workspaceStore.ts:308`) is generalised to cover both; an older build reading a newer layout hits
  `UnknownPaneFallback` rather than crashing; side panes are read-only, so every accept action stays
  in the result pane; block↔side mapping is a monotonic text search, not a diff computation, which is
  what keeps the CDN-loader constraint intact; the view tears itself down when the path stops being
  unmerged, consistent with ADR-0029's index-derived rule.
- **`CONTEXT.md` `## Language`** — add:
  - **Merge view**: a transient three- or four-pane arrangement for one conflicted file — read-only
    **Current** and **Incoming** side panes above the editable result pane, with an optional **Base**
    side pane. Toggled from the conflict toolbar; torn down automatically when the path stops being
    unmerged. Not a distinct editor — it is ordinary **Panes** in the tab's split tree.
    _Avoid_: merge editor, 3-way editor, conflict editor, merge pane.
  - **Merge side pane**: a read-only **Pane** showing one index stage of its **source pane**'s
    conflicted file. Owns no file; mirrors a stage. The same derived-pane shape as a **Preview pane**
    (ADR-0001). _Avoid_: stage pane, side editor, ours pane / theirs pane.
  - **Section** (Git changes tab): a pair of git endpoints being compared — `untracked`, `unstaged`
    (index vs worktree), `staged` (HEAD vs index), `against_base` (merge-base..HEAD). **Conflicted**
    is the deliberate exception: a *state*, not an endpoint pair.
  - **Conflicted section**: the first section, listing unmerged paths from the index's conflict
    stages. Rows carry no line counts and open an editable **file pane**, not a diff pane — the only
    section that does. _Avoid_: merge section, conflicts panel, unmerged panel.
  - **Conflict block**: one `<<<<<<< / ======= / >>>>>>>` region, comprising a **Current side** and
    an **Incoming side** (plus an **ancestor side** under diff3/zdiff3). Recognised by git's own rule
    — exactly seven characters at column 0 — so the two never disagree. _Avoid_: hunk, conflict hunk,
    merge chunk, conflict region.
  - **Current side / Incoming side**: the two halves, named after the labels git writes into the
    markers. Deliberately not "ours"/"theirs", which invert during a rebase — those stay in Rust,
    where they are git's index vocabulary. _Avoid_: ours, theirs, local/remote, left/right.
  - **Resolve & stage**: the only write Abundio performs on a conflict — save the buffer, then
    `git add`. It does not finish the operation. _Avoid_: merge, finish merge, commit the merge.
- **`CONTEXT.md` `## Relationships`** — the **Conflicted section** is the one Git changes tab section
  whose rows open a text-mode **file pane**; and a conflicted file appears simultaneously in
  Conflicted and in Against-base, because they compare different things.
- **`CONTEXT.md` `## Flagged ambiguities`** — two entries:
  - The Git changes tab's sections *look* like one taxonomy but are two: four endpoint pairs plus one
    state. Resolved deliberately — Conflicted is listed as a section because that is where users look
    for it, and the double-listing of a conflicted file is correct, not a duplicate.
  - "ours"/"theirs" are used in Rust (git's index vocabulary, matching `git checkout --ours`) and
    forbidden in the UI, which says Current/Incoming. The boundary is the IPC layer. User-visible
    text for marker-less conflicts names **neither** side, because a rebase inverts them and those
    files have no marker labels to read.
- **`CONTEXT.md:229` and ADR-0021** — reword the index invariant per decision 1. Do not delete it.

## Commit sequence

1. `docs: plan for resolving merge conflicts`
2. `refactor(git): share the repo-relative path validator` — pure refactor, own test
3. `fix(watcher): see gitdir changes in linked worktrees` — §3; standalone pre-existing bug fix
4. `feat(git): surface unmerged paths as a conflicted section` — §2 + §5 together; ships a working
   read-only feature and cannot leave the unknown-section hole open
5. `feat(git): read conflict stages and stage a resolution` — §4
6. `feat(editor): parse git conflict markers` — §6 + full Vitest suite; pure, no wiring
7. `feat(editor): inline conflict decorations and code lenses` — §7; visual only, no writes
8. `feat(editor): resolve and stage from the conflict toolbar` — §8. **Feature-complete for the
   inline UX** — everything after this is the Merge view, and the branch is shippable here if the
   remaining work needs to be split off.
9. `refactor(panes): generalise derived-pane helpers beyond previews` — the `paneTree.ts` rename to
   `findDerivedForSource` / `pruneOrphanDerived` with preview wrappers. Pure refactor, existing tests
   must pass untouched.
10. `feat(editor): merge side panes` — the `mergeSide` `PaneNode`, `mergeView.ts`, `MergeSidePane`,
    `SplitContainer` branch, `CodeEditor` `readOnly`, orphan + resolved pruning.
11. `feat(editor): map conflict blocks onto merge side panes` — `mapBlocksToSide` + its tests, the
    `scrollSync` editor↔editor path, reveal and highlight, the Base toggle.
12. `docs: ADR-0029, ADR-0030 and conflict vocabulary` — §10

## Verification

**Rust** (`cd src-tauri && cargo test`). `run_git_test` (`git_commands.rs:373-387`) **panics on
non-zero exit**, and `git merge` on a conflict exits 1 — so add `run_git_test_allow_fail` returning
`Output` without asserting status, plus a `make_conflicted_repo()` fixture. Cases:

- conflicted section lists the path exactly once, `status == "U"`, absent from
  staged/unstaged/untracked
- `files[0].section == "conflicted"`
- `against_base` still lists it (pins the deliberate double-listing, decision 3)
- `git_conflict_file` returns all three stages, `kind == "both_modified"`
- delete conflict → `deleted_by_them`, `theirs.is_none()`
- binary conflict → `is_binary`, all text fields `None`
- `git_stage_path` → `index.has_conflicts() == false`, path now under `"staged"`
- `git_stage_path` on a missing file stages the deletion
- absolute and `..` paths rejected, index byte-identical afterwards
- `operation_in_progress` returns `"merge"` mid-merge and `None` after `--abort`
- **linked worktree**: create one with `git worktree add`, conflict inside it, assert the conflicted
  section and `operation_in_progress` are both correct there (pins decision 6's libgit2 half)

**Frontend** (`pnpm test`). `src/lib/__tests__/conflictMarkers.test.ts` — two-way and diff3 blocks,
two blocks in one file, CRLF round-trip, no trailing terminator, unterminated `<<<<<<<` → `[]`,
stray `=======` before any opener (and a valid block after it still parses as index 0), eight
chevrons and an indented marker not matching, empty current side, all four `resolveBlock` choices,
and idempotence (resolving block 0 leaves `length - 1` blocks with shifted line numbers).
`gitChangesStore` — `unstaged → conflicted` updates `changedFiles` (pins the `filesEqual` field
list); `applyBundle` writes `conflictedPaths` for a **non-active** workspace (pins decision 8).
`explorerStore` — a conflicted path opens as `fileType: "text"` on the plain path and `saveFile`
calls `fsApi.writeFile`, so a later "add a conflict fileType" refactor breaks a test whose name
explains why. `GitChangesFileList` — Conflicted renders first and only when non-empty.

`src/lib/__tests__/conflictMarkers.test.ts` also covers `mapBlocksToSide`: two blocks whose current
text is **identical** map to two *different* ranges (the monotonic-cursor property — this is the test
that fails if someone replaces it with a plain `indexOf`); a block whose side text is absent maps to
`null` without disturbing the blocks after it; an empty side maps to a zero-length range.
`src/lib/__tests__/paneTree.test.ts` — extend the existing `preview` fixture (`:401`) so
`pruneOrphanDerived` handles a mixed tree of `preview` and `mergeSide` orphans.
`src/lib/__tests__/mergeView.test.ts` — toggle from the result pane and from a side pane both
resolve to the same source; `pruneResolvedMergeSides` removes sides once the path leaves
`conflictedPaths`; the Base toggle is a no-op for `both_added`.

**End to end** (`pnpm tauri dev`), in a scratch repo:

1. Create a conflict. Confirm the Conflicted section appears **first** with a red `U`, the
   operation-in-progress line reads "Merge in progress", and the file also still appears under
   Against-base (decision 3).
2. Click the conflicted row → editable text pane, no hover "Open File" button on that row
   (decision 2). Decorations and three lenses present. Accept a block; confirm **Cmd+Z undoes it**
   (pins `executeEdits` over `setValue`).
3. **Delete the markers by hand and confirm the toolbar is still there** with *Resolve & stage*
   enabled — this is decision 7, and the agent-resolved workflow depends on it.
4. *Resolve & stage* → the row moves to Staged **without a manual refresh** (pins the forced
   `fetchChanges`).
5. Run `git merge --continue` in a terminal pane → the operation-in-progress line **clears**.
   Repeat the whole flow inside a `git worktree add` Linked worktree; the line must clear there too
   (pins decision 6's watcher half — it will not clear without the fix).
6. `git merge --abort` with a conflict pane open → markers and toolbar vanish on their own.
7. **Merge view**: toggle it on. Current and Incoming appear above the result pane, read-only, with
   correct syntax highlighting. Move the cursor between conflict blocks in the result pane and
   confirm both sides reveal and highlight the matching region. Toggle Base on and off. Accept a
   block and confirm the sides stay put (they show stages, which don't change) while the result pane
   updates.
8. With the Merge view open, resolve and stage the file → the side panes **close by themselves**
   (`pruneResolvedMergeSides`). Then reopen a merge view, quit and relaunch the app, and confirm the
   restored layout is sane — either the view comes back intact or its orphaned sides are pruned,
   never a broken pane.

Also `pnpm check` and `cargo check`.
