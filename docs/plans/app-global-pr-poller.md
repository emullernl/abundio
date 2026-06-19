# App-global GitHub PR poller (single GraphQL call, client-side All/Repo filter)

## Context

PR fetching fires a lot of `gh` subprocesses, which GitHub flags as "scraping":

- All gh traffic lives in `src-tauri/src/gh_commands.rs` (5 commands) driven **per window** by `src/hooks/useGitDataSync.ts`.
- Each poll cycle runs `gh search prs` **plus** a second `gh api graphql` enrichment call (the search API omits `reviewDecision`/`statusCheckRollup`). In the default "All" view that's ~4 subprocesses every **60 s**, ×**every open window**.
- Repo-vs-All is done by calling *different* commands (`gh pr list` vs `gh search prs`).

**Goal:** collapse this into **one `gh api graphql` call** returning both PR lists (mine + review-requested) *with* CI status and approval status, run **once for the whole application** on a **5-min-when-focused / 1-hr-when-backgrounded** cadence (focused interval configurable + disable-able in Settings), with All-vs-Repo filtering done **client-side**.

**This deliberately reverses ADR-0005**, which considered and rejected "a dedicated global PR fetcher with its own timer/focus lifecycle." Justified because (a) the driver changed from cosmetic empty-state behaviour to GitHub **rate-limit/scraping** sustainability; (b) the domain favours it — GitHub identity is **global, not per-Profile**, and the `-all` queries are already account-scoped, so per-workspace fetching was always N redundant fetches of identical data; (c) ADR-0005's "duplicated auth/error/cache" objection inverts — the global poller is the *single* owner, so there's *less* total handling. Recorded as **ADR-0019**; ADR-0005's rejected-alternative paragraph is marked superseded.

## Architecture

```
Rust (once, app-global)                          Frontend (every window)
─────────────────────────                        ─────────────────────────
PrPoller background task                         listen("pr-state") ──► prStore
  every {focused interval | 60 min bg}             • raw reviewRequested[] + mine[]
  └─ one `gh api graphql` (both lists)             • globalCounts = list lengths
  └─ diff vs cached last payload                   • selectors filter All-vs-Repo
  └─ emit("pr-state", full lists)  ──broadcast►      via activeRepoSlug
  └─ emit("pr-changes", descriptors) ─to ONE──►    listen("pr-changes") ──► sendNotification
       profile window (updater pattern)              (one window only; blur-gated)
  └─ caches last payload
new window mount ──► pr_poller_snapshot() (cached, no gh call)
manual Refresh / focus-gain / settings change ──► notify task ──► immediate poll
```

Two cadences (not pause): each cycle the task computes its effective interval — the user-configured minutes when **any** Abundio Window is frontmost (Settings included), else fixed **`BACKGROUND_INTERVAL = 60 min`**. "Off" disables timer + focus fetches (manual Refresh still works).

## Backend (Rust)

### New module `src-tauri/src/pr_poller.rs` (model on `updater.rs` + `git_scheduler.rs`)

- `pub struct PrPoller`, managed via `app.manage()`. Holds:
  - `interval_minutes: AtomicU32` (focused cadence, default 5, clamp 1–30), `enabled: AtomicBool` (default true; pushed from frontend on rehydrate, mirroring `UpdaterState::auto_check`, `updater.rs:63`).
  - `notify: tokio::sync::Notify` (wake on settings change / manual refresh / focus-gain).
  - `last: Mutex<Option<PrStatePayload>>` (cached snapshot for new windows **and** the prev-state for the diff).
  - `last_fetch: Mutex<Option<Instant>>` (the min-gap clock).
- `start(app)` spawned in `lib.rs` via `tauri::async_runtime::spawn` (like `updater::start_auto_check`, `updater.rs:133`). Loop:
  1. After `INITIAL_DELAY` (~2 s, off the launch critical path).
  2. Wait phase: `effective = focused()? interval_minutes : BACKGROUND_INTERVAL`; `tokio::select! { _ = sleep(effective) => Timer, _ = notify.notified() => Woken }`.
  3. Act phase — fetch iff:
     - **Timer** elapsed and `enabled`; or
     - **manual refresh** (always — ignores `enabled`); or
     - **focus-gain** and `enabled` and `now - last_fetch >= interval_minutes` (min-gap = the focused interval, read live — *not* a fixed 60 s).
     - **config change / focus-loss** → no fetch, just re-loop to recompute the wait.
  4. On fetch: stamp `last_fetch = now`, run `fetch_and_emit`, store payload in `last`.
- `focused()` = any `app.webview_windows()` reports `is_focused()` (any window, Settings included).
- Commands (register in `lib.rs`):
  - `pr_poller_set_config(enabled, minutes)` — store atomics + `notify`.
  - `pr_poller_refresh()` — invalidate the gh auth cache (`invalidate_gh_auth_cache`, `gh_commands.rs:164`) **then** signal a fetch-now (bypasses `enabled` and the min-gap). Backs the Refresh button and recovers after `gh auth login`.
  - `pr_poller_snapshot() -> Option<PrStatePayload>` — return cached `last` (no gh call).

### `fetch_and_emit` — the single GraphQL call + the diff

- Reuse the availability/auth cache: `check_gh_auth()` + `GH_AUTH_CACHE` (`gh_commands.rs:153-184`). Unavailable/unauthed → emit a payload with `available`/`authenticated` false + empty lists; skip the network call. When unauthed, the poller still wakes each interval and re-checks auth (cheap) but skips graphql.
- One `gh api graphql -f query=<Q>` from the home dir (reuse `run_gh` with empty cwd, `gh_commands.rs:118`).
- `Q` = two aliased `search` connections on a shared PR field set:
  ```graphql
  query {
    reviewRequested: search(query: "is:open is:pr review-requested:@me archived:false", type: ISSUE, first: 100) { nodes { ...pr } }
    mine:            search(query: "is:open is:pr author:@me archived:false",          type: ISSUE, first: 100) { nodes { ...pr } }
  }
  # fragment pr on PullRequest:
  #   number title url isDraft createdAt updatedAt additions deletions
  #   author { login }  repository { nameWithOwner }
  #   headRefName baseRefName reviewDecision
  #   labels(first: 20) { nodes { name } }
  #   commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  ```
  Use `statusCheckRollup { state }` directly (verified against the existing enrichment query's `commits(last:1){…statusCheckRollup}` shape, `gh_commands.rs:370`). Map `ERROR→FAILURE`, `EXPECTED`/null→`PENDING`/`""` to match the frontend `CiDot`. `first: 100` per list = parity with today's `--limit 100`; if a connection reports more, `log!`/surface it (no silent cap).
- Parse into the **existing** `PullRequest` struct (`gh_commands.rs:19-37`) — it already has every queried field.
- **Diff (moved from JS):** compare the new lists against `last`. Emit two events:
  - `pr-state` `{ available, authenticated, reviewRequested, mine, error }` → `app.emit` (**broadcast** to all windows, the `git-state-*` pattern, `git_scheduler.rs:179`).
  - `pr-changes` `[descriptor…]` (new review requests + my-PR `reviewDecision`/`statusCheckRollup` transitions, each `{ title, number, repository, kind }`) → **single-target** `emit_to` the focused profile window, else any profile window, via the updater's selection (`emit_update_available` / `is_profile_window_label`, `updater.rs:113-129`). Fixes the duplicate-notification bug the broadcast model would otherwise create (N windows → N identical OS notifications when backgrounded).

### Slim down `src-tauri/src/gh_commands.rs`

- **Remove:** `gh_review_requests`, `gh_review_requests_all`, `gh_my_prs`, `gh_my_prs_all`, `gh_status`; `enrich_search_prs`, `build_enrichment_query`, `parse_search_prs`, `parse_pr_list`; `GhPrListItem`, `GhSearchPrItem`, `PR_LIST_FIELDS`, the per-repo enrichment structs.
- **Keep/reuse:** `PullRequest`, `GhStatus`, `run_gh`, `check_gh_auth` + cache + `invalidate_gh_auth_cache`, `rollup_status`. Add the combined-query builder + response parser (here or in `pr_poller.rs`).

### Client-side repo filter helper — `src-tauri/src/git_libgit2.rs`

- Add `pub fn github_repo_slug(cwd: &str) -> Option<String>` beside `has_github_remote` (`:369`), reusing `url_is_github` (`:386`). Read origin (fall back to any github remote), parse `owner/repo` from HTTPS (`https://github.com/owner/repo(.git)`) and SSH (`git@github.com:owner/repo(.git)`).
- Expose as command `git_repo_slug(cwd) -> Result<Option<String>, AbundioError>` (in `commands.rs`; register in `lib.rs`). Replaces the removed per-workspace `hasRemote` signal — strictly more precise (it identifies *which* repo, which the filter needs anyway).

### `src-tauri/src/lib.rs`

- `app.manage(pr_poller::PrPoller::new())` then `pr_poller::start(app.handle().clone())` in setup (next to `updater::start_auto_check`).
- Register the four new commands in `generate_handler!`.
- On `WindowEvent::Focused(true)` → `pr_poller.notify()` (drives the focus-gain refresh from Rust, no JS round-trip). No capability changes — `core:default` already covers broadcast + `emit_to` for `window-*`/`settings`.

## Frontend

### `src/lib/types.ts` & `src/lib/ipc.ts`

- Add `PrStatePayload` and `PrChange` types. `PullRequest` type is already complete (`types.ts:232-248`).
- Replace the `gh` IPC object (`ipc.ts:471-483`) with `pr`: `pr.onPrState(cb)`, `pr.onPrChanges(cb)`, `pr.snapshot()`, `pr.refresh()`, `pr.setConfig(enabled, minutes)`; plus `git.repoSlug(cwd) -> Promise<string | null>`.

### `src/stores/prStore.ts` (significant simplification)

- State = raw account-wide datasets `reviewRequested`, `mine`, plus `ghStatus { available, authenticated }`, `activeRepoSlug: string | null`, persisted `reviewView`/`myPrsView`.
- `applyPrState(payload)` sets `ghStatus` + both raw lists.
- `globalReviewCount`/`globalMyPrsCount` = list lengths (always account-wide — preserves ADR-0005's Overview-bar contract).
- Selectors `visibleReviewPrs`/`visibleMyPrs`: in `*-repo` view with `activeRepoSlug` set → filter `pr.repository === activeRepoSlug`; else full list. Empty-Opened-set forces `-all` (no `activeRepoSlug` → nothing to filter to). View setters just set state (no fetch).
- **Remove** `prCacheByWorkspaceId`, `hydrateFromWorkspace`, per-view command branching, the `-all` piggyback, the generation guards, **and the entire `usePrStore.subscribe` notification block (`:311-435`)** — the diff now lives in Rust. Keep `partialize` persisting the two views.

### Notifications (single-window listener)

- A `pr.onPrChanges` listener (registered in every window root per the multi-window rule, but Rust `emit_to`s only one window so only that one fires). Applies the existing blur gate (`getWindowBlurredMs() >= NOTIFICATION_BLUR_THRESHOLD_MS`) and calls `sendNotification` with `currentNotificationTitle()` and `extra: { type:"pr", workspaceId }`. The blur gate + updater target-selection compose: focused → Rust targets the (non-blurred) focused window → JS suppresses; backgrounded → Rust targets any profile window (blurred) → JS fires.

### `src/hooks/useGitDataSync.ts`

- **Remove** the gh polling block (`GH_OPEN_MS`/`GH_COLLAPSED_MS`, `checkGhStatus`/`fetchReviewPrs`/`fetchMyPrs`, the no-workspace fallback poller). Leave the git scheduler untouched.
- On mount: `pr.snapshot()` to hydrate immediately (first window at launch gets `null` → waits ~2 s for the initial poll), then `pr.onPrState(applyPrState)` + `pr.onPrChanges(...)`. **No** forced refresh on window-open.
- On active-workspace change: `git.repoSlug(cwd)` → set `activeRepoSlug` (null when no github remote → repo view shows "No GitHub remote found").

### `src/components/GitChanges/PullRequestsSection.tsx`

- Read `visibleReviewPrs`/`visibleMyPrs`. `handleRefresh` → `pr.refresh()`. View toggles → setters only. Empty-state branches (`:287-327`) key off `ghStatus.available/authenticated` and `activeRepoSlug` instead of `hasRemote`.
- **Off state:** when `prPollEnabled` is false, show a *"Pull request polling is off"* empty state with a deep-link to Settings → GitHub. The Refresh button stays enabled (one-shot fetch).

### Overview bar (`OverviewBar.tsx` + parent wiring)

- When `prPollEnabled` is false, render the two PR chips **dimmed with a "PR polling is off" tooltip** (not a misleading `0`, not a stale count shown as live) — consistent with the existing dimmed-zero treatment.

### Settings (new "GitHub" section)

- `src/stores/settingsStore.ts`: add `prPollEnabled: boolean` (default true) + `prPollIntervalMinutes: number` (default 5), setters that also `pr.setConfig(enabled, minutes)` and push on rehydrate (mirror `setAutoCheckUpdatesEnabled`). Add to `PERSISTED_DEFAULTS`, `partialize`, bump store version.
- `src/SettingsApp.tsx`: add both fields to `SettingsSlice` + `sliceOf` so they sync across windows.
- `src/components/SettingsPanel.tsx`: new `"github"` nav item/section with an **Off toggle** + an **interval slider 1–30 min (default 5)** mirroring `FontSizeControl` (`:360-436`); disable the slider when Off.

### Demo mode

- Update `src/lib/demo/mockInvoke.ts` (replace `gh_*` cases with `pr_poller_snapshot`/`pr_poller_refresh`/`git_repo_slug`) and emit a `pr-state` event from the mock listen layer using `fixtures.ghStatus` + a fixtures PR list, so `pnpm demo` still populates the panel.

## Files to modify

- **Rust:** new `src-tauri/src/pr_poller.rs`; edit `gh_commands.rs`, `git_libgit2.rs`, `commands.rs`, `lib.rs`.
- **Frontend:** `src/lib/ipc.ts`, `src/lib/types.ts`, `src/stores/prStore.ts`, `src/stores/settingsStore.ts`, `src/hooks/useGitDataSync.ts`, `src/components/GitChanges/PullRequestsSection.tsx`, `src/components/OverviewBar.tsx` (+ its parent in `App.tsx`), `src/components/SettingsPanel.tsx`, `src/SettingsApp.tsx`, demo files. `PullRequestItem.tsx` only if empty-state props shift.
- **Docs:** `docs/adr/0019-app-global-pr-poller.md` (new); `docs/adr/0005-overview-bar.md` (supersede note); `CONTEXT.md` (empty-state flagged-ambiguity + Overview bar ADR ref).

## Tests

- **Rust (`pr_poller.rs` / `gh_commands.rs`):** parse a sample combined GraphQL response into `{reviewRequested, mine}` (success, empty, draft/no-checks, failing-checks); `statusCheckRollup.state` mapping (ERROR→FAILURE, EXPECTED→PENDING, null→""); the **diff** (new review request, `reviewDecision` transition, `statusCheckRollup` transition, no-change → empty); `github_repo_slug` URL parsing (https, ssh, trailing `.git`, non-github → None); focused-vs-bg interval selection + min-gap gate (extract as a pure function).
- **Frontend (`prStore`):** `applyPrState` sets lists + counts; `visible*` selectors filter by `activeRepoSlug` in repo view, pass through in all view, force-all when slug is null; view switch fires no fetch. `onPrChanges` listener fires `sendNotification` only past the blur threshold. Mock `pr` IPC via `vi.mock("../ipc")`.

## Verification

1. `cd src-tauri && cargo test` and `pnpm test` green; `pnpm check` clean.
2. `pnpm tauri dev`, GitHub-authed `gh`, workspace on a GitHub repo: panel populates from `pr-state` (not per-window invokes); Repo↔All toggles filter instantly with **no** new gh process.
3. Watch process activity: exactly **one** `gh api graphql` per cycle; ~5 min focused, ~1 hr backgrounded; **zero** when Off; an immediate poll on returning focus only if ≥1 interval since the last fetch.
4. Open a **second** window → hydrates instantly via `pr_poller_snapshot` (no extra gh call); both windows update together on the next poll.
5. **Notifications fire exactly once** with two windows open + app backgrounded when a review is requested / a CI or approval state flips.
6. Settings → GitHub: change interval / toggle Off → takes effect immediately and syncs to the other window. Off → chips dimmed with tooltip, PR section shows the off state, **Refresh still does a one-shot fetch**.
7. CI dot + approval badge render. A workspace with no GitHub remote shows the repo-view empty state; `gh auth login` after a failed start is picked up on the next Refresh.
