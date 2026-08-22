---
status: accepted
---

# Conflict resolution happens in a text pane

A conflicted file opens as an ordinary editable **file pane** on its plain path, and the conflict UI is derived from the working tree's own `<<<<<<< / ======= / >>>>>>>` markers — not a dedicated merge pane, and not a **diff pane**. Abundio's only write to git is `git add`; `merge --continue`, `rebase --continue` and `--abort` stay in the terminal. The organising rule is: **rendering is derived from the text, writing is derived from the index.**

## Why this shape

The standalone Monaco distribution ships no merge-editor widget — only `codeEditor`, `diffEditor`, `markdownRenderer` and `multiDiffEditor`. But the deeper reason is that **the conflicted working file already *is* the three-way merge, serialized by git**. An inline UI therefore needs only a marker parser and a string splice, where a two-pane ours/theirs editor would need us to write a merge *serializer* to reconstitute the file from two edited sides.

Reusing `fileType: "text"` rather than adding a third pane type is what keeps the change small. A `fileType: "conflict"` keyed `conflict:${path}` would have forced changes to `saveFile`, `handleFsChange`, `reloadPaneFromDisk`, the `FileType` union and SQLite layout persistence — and a restored `conflict:` pane whose merge finished mid-session would point at a state that no longer exists. Because the conflict UI is derived state instead, `merge --abort`, merge completion and app restart all resolve themselves through paths that already work.

Keying the toolbar off the **index** rather than off markers in the buffer matters more than it looks. In this app the likeliest workflow is asking the agent in the next pane to resolve the conflict — after which the markers are gone but the path is still unmerged (stages 1/2/3 intact, no stage 0, git still refusing to continue). A marker-based rule would remove the staging button exactly when it is needed, in the scenario Abundio exists to serve.

Confining the write surface to `git add` keeps every operation that can lose work in the terminal, where the user can see git's own output.

## Consequences

- **The on-disk index is written for the first time.** `git_stage_path` is the sole writer. The invariant recorded on `snapshot_worktree_tree` and in ADR-0021 is *reworded, not dropped*: Abundio writes the index only on explicit user action, never as a side effect of telemetry, polling or rendering. That is a stronger and more portable promise than "never", and it keeps ADR-0021's actual protection intact.
- **The Conflicted section's rows open a text pane**, unlike every other section, and therefore drop the hover-revealed "Open File" button as a duplicate. An `against_base` row is something you review; a conflicted row is something that is blocking you.
- **A conflicted file is listed twice** — under Conflicted and under Against-base. Not a duplicate: those two sections compare different things (see the Section entry in CONTEXT.md). It is deduped out of staged/unstaged/untracked, where an unmerged path has no honest entry.
- **User-visible text names neither side.** "Deleted by them" is backwards during a rebase, and marker-less conflicts carry no marker labels to read the truth from. `ours`/`theirs` remain in Rust, where they are git's own index vocabulary; the IPC layer is the boundary.
- **Binary conflicts are out of scope.** Choosing a side means writing a blob to the worktree, a bigger write than "save the buffer, `git add`".
- **Finishing the operation stays in the terminal**, and the Git changes tab says so with a single read-only line driven by `repo.state()` — which is worktree-correct, unlike probing for `.git/MERGE_HEAD`.
- **The CodeLens provider is global**, registered once for all languages and scoped per model by URI, with an `onDidChange` emitter driving re-query. Monaco has no per-model registration, and without the emitter the lenses go stale after the first resolution.
- **Staging must refresh the tab explicitly.** `.git/index` is deliberately excluded from the file watcher, so the Rust scheduler never observes an index write.
