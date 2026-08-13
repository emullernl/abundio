# Profile-scoped pull request views

## Context

The **Pull Requests** section in the **Right sidebar** has two sub-sections — Review Requested and
My Open PRs — each with a dropdown offering **All** (every PR on the GitHub account) and **Repo**
(only the **Active workspace**'s repository). Nothing sits in between: with many unrelated repos on
one account, All is noise and Repo is too narrow. The same gap shows in the **Overview bar** chips,
which are account-wide.

Add a third scope, **Profile**, to both dropdowns and make it the default: show only PRs whose
repository is one that the **Active profile**'s Workspaces resolve to. The Overview bar chips
become Profile-scoped too. OS notifications stay account-wide.

Terminology note — the request was phrased as "projects in the current profile". In canonical
terms (`CONTEXT.md`): *"current profile"* is an `_Avoid_` term for **Active profile**, and the
things being matched are **repositories**, not Workspaces — a **Worktree set** means several
Workspaces can resolve to one repository, and (see below) one Workspace can contribute several.

Most of the machinery already exists: the app-global poller (ADR-0019) pushes one account-wide
dataset that the panel filters client-side via `visiblePrs`, each `PullRequest` carries
`repository` as `"owner/repo"`, and `git_workspaces_summary` already runs across every Workspace of
the Active profile whenever the list changes. The missing piece is repository identity per
Workspace.

## Decisions taken during grilling

| Question | Decision |
|---|---|
| Name | **Profile** — labels `Review Requested (Profile)` / `My Open PRs (Profile)`; canonical term **Profile scope** |
| Which repos | Every GitHub remote of every Workspace in the Active profile (not just `origin`) — so fork PRs on `upstream` stay visible |
| Overview bar chips | Become Profile-scoped, always, independent of the dropdowns |
| Notifications | Stay account-wide — `pr-changes` goes to a single Window, so filtering would drop them entirely |
| Counts | Derived, never stored — they depend on two inputs (payload + slug set) |
| Zero Opened workspaces | A stored `-repo` view falls back to **Profile**, not All; dropdown stays interactive |
| Empty profile set | Explicit message, never a silent fall back to All |
| Existing preference | One-time reset to Profile via a persist version bump |
| IPC | Extend `WorkspaceGitSummary`; no new command |
| Docs | New **ADR-0028**, with pointers from ADR-0005 and ADR-0019 |

## Changes

### 1. Repository identity per Workspace (no new IPC)

- `src-tauri/src/git_libgit2.rs` — new `pub fn github_repo_slugs(cwd: &str) -> Vec<String>`:
  every remote's fetch **and** push URL run through the existing `parse_github_slug`, deduplicated,
  order-stable. `github_repo_slug` (single, origin-preferring) stays as-is for the Repo scope.
- `src-tauri/src/git_commands.rs` — add `pub repo_slugs: Vec<String>` to `WorkspaceGitSummary`,
  filled in `compute_workspace_git_summary`. The repo is already open there for the worktree bits,
  so this is a config read. Widen the struct's doc comment from "branch detection only" to
  "per-workspace git facts".
- `src/lib/ipc.ts` — add `repoSlugs: string[]` to the `WorkspaceGitSummary` type.
- `src/stores/workspaceGitStore.ts` — new `repoSlugsById: Record<string, string[]>` and
  `repoSlugsResolved: boolean`, populated in `syncWorktreeFacts` (already batched over the whole
  profile list by `useWorktreeSync`) and in `fetchAll`; entry dropped in `remove()`.
- `src/lib/demo/fixtures*` — return `repoSlugs` from `workspaceSummary()`, reusing `repoForCwd`.

### 2. `src/stores/prStore.ts` — one filter rule, derived counts

- Extend the unions with `"review-profile"` / `"mine-profile"`; add the two labels; defaults become
  the profile variants.
- Replace the boolean argument with an explicit scope:

  ```ts
  export type PrScope = "all" | "repo" | "profile";
  export function scopeOf(view: PrView): PrScope;      // suffix after the "-"
  export function visiblePrs(
      prs: PullRequest[],
      scope: PrScope,
      activeRepoSlug: string | null,
      profileRepoSlugs: Set<string>,
  ): PullRequest[];
  ```

  `repo` + known slug → filter to it; `repo` + null slug → full list (unchanged); `profile` →
  `prs.filter(pr => profileRepoSlugs.has(pr.repository))`, **including when the set is empty**
  (empty result, not a fall back to All); `all` → full list.
- New state `profileRepoSlugs: Set<string>` + `repoSlugsResolved: boolean`, with a
  `setProfileRepoSlugs(slugs)` setter. A small effect (alongside the existing slug resolution in
  `useGitDataSync`) pushes the deduped union of `repoSlugsById` for the current
  `useWorkspaceStore.workspaces` into it — deriving from the *workspace list*, not from every key
  in the map, so entries left behind by a profile switch can never leak in.
- **Delete** the stored `globalReviewCount` / `globalMyPrsCount`. Export
  `profilePrCounts(state): { review: number; mine: number }` computed with the same `visiblePrs`
  rule, so the chips and the panel can never disagree (ADR-0020's "derive live" lesson).
- Persist: add `version: 1` and a `migrate` that force-sets both views to the profile variants when
  coming from unversioned state. Note `abundio-pr-panel` lives in per-webview localStorage, so each
  Window migrates independently — which is right, since each Window has its own Active profile.

### 3. `src/components/GitChanges/PullRequestsSection.tsx`

- Option lists become `["review-profile", "review-all", "review-repo"]` and the `mine-` equivalent,
  Profile first.
- Replace the blanket `noWorkspace` lock: when the Opened set is empty, a stored `-repo` view is
  coerced to the **`-profile`** variant and Repo is omitted from the dropdown; the dropdown stays
  interactive and the stored preference is untouched. The `locked` prop and its static-label branch
  go away.
- Pass `scopeOf(effView)` and the slug set into the two `visiblePrs` memos.
- Empty-state ladder, after the existing `isRepoView && !hasRepo` branch:
  `scope === "profile" && !repoSlugsResolved` → "Loading repositories…";
  `scope === "profile" && profileRepoSlugs.size === 0` → **"No GitHub repositories in this
  profile"**; otherwise the existing "No pull requests".
- Refresh now also re-runs the batch workspace summary (so a newly added remote is picked up
  without a restart) alongside `pr.refresh()`; the existing spin floor/timeout logic is unchanged.

### 4. `src/components/OverviewBar.tsx` + `src/App.tsx`

- `reviewRequestedPrs` / `myOpenPrs` come from `profilePrCounts` instead of the deleted global
  counts. Until `repoSlugsResolved`, render the two PR tiles dimmed (reuse the existing
  `enabled={prPollingEnabled}` dim path) rather than a hard `0`.
- Reword the two tile tooltips to say the counts are for this profile.

## Documentation

- **New `docs/adr/0028-pr-views-are-profile-scoped-by-default.md`** — the third scope, Profile as
  default, the chip reversal, why notifications stay account-wide, and why counts are derived.
- ADR-0005 and ADR-0019 — one-line dated "superseded in part by ADR-0028" pointers.
- ADR-0017 — one line noting `WorkspaceGitSummary` now also carries GitHub identity.
- `CONTEXT.md`:
  - New term **Profile scope** near the Right sidebar / PR entries.
  - Line 160 (**Overview bar**) — PR counts are Profile-scoped, not account-wide.
  - Line 163 (**Status bar**) — fix the "Overview bar carries *global* … PR counts" contrast.
  - Line 221 flagged ambiguity — rewrite: the empty-Opened-set state now degrades `-repo` to
    `-profile`, and the dropdown is no longer locked.
  - Line 224 flagged ambiguity — the Overview bar is no longer purely global chrome; record the
    deliberate split that its PR counts follow the Active profile while OS notifications remain
    account-wide, and why (single-Window `pr-changes` emission).

## Tests

- `src/stores/__tests__/prStore.test.ts` (extend, reusing `makePr()` / `makePayload()`): the new
  labels; `scopeOf` mapping; `visiblePrs` under profile scope — match, non-match, empty set returns
  `[]`, repo/all unchanged; `profilePrCounts` reacting to a slug-set change with no new payload;
  the persist migration turning legacy `review-all`/`mine-all` into the profile views.
- `src/stores/__tests__/workspaceGitStore.test.ts`: `syncWorktreeFacts` fills `repoSlugsById` and
  flips `repoSlugsResolved`; `remove()` drops the entry; slugs left over from a previous profile do
  not reach `profileRepoSlugs`.
- Rust, in `git_commands.rs` / `git_libgit2.rs` tests: a temp repo with `origin` + `upstream`
  GitHub remotes yields both slugs deduplicated; a repo with no remote yields an empty vec; a
  non-GitHub remote is ignored. URL-form parsing is already covered by `mod slug_tests`.

## Verification

1. `cd src-tauri && cargo test`; `pnpm test`; `pnpm check`; `pnpm build`.
2. `pnpm demo` — both sub-sections open on the Profile view and list only the demo profile's repos;
   switching to All shows more.
3. `pnpm tauri dev`:
   - After the one-time migration both dropdowns read `(Profile)`, and the Overview bar chips match
     the section counts.
   - Open a second Window on another Profile — its panel and chips show a different set, while the
     same OS notification behaviour continues for both.
   - A Workspace whose `origin` is a fork and `upstream` is the base repo: your PR on the base repo
     appears in the Profile view.
   - Close every Workspace: the dropdown still offers Profile and All (no Repo), and a previously
     stored Repo preference displays as Profile, reverting on reopen.
   - A Profile with no GitHub remotes shows "No GitHub repositories in this profile" and dimmed
     chips — never a flash of that message during startup.
   - `git remote add origin …` in a Workspace folder, then hit Refresh: the repo joins the set
     without a restart.
