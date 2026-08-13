import { sendNotification } from "@tauri-apps/plugin-notification";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
	GhStatus,
	PrChange,
	PrStatePayload,
	PullRequest,
} from "../lib/types";
import {
	getWindowBlurredMs,
	NOTIFICATION_BLUR_THRESHOLD_MS,
} from "../lib/windowFocus";
import { currentNotificationTitle } from "./profileStore";
import { useWorkspaceStore } from "./workspaceStore";

/** Every view each sub-section can hold, in the order its dropdown offers them:
 *  the default first, then narrow → wide. These are the single source of truth —
 *  the types, the dropdown lists and the migration's validation all derive from
 *  them, so a fourth scope can't be added to one and missed by another. */
export const REVIEW_VIEWS = [
	"review-profile",
	"review-repo",
	"review-all",
] as const;
export const MY_PRS_VIEWS = ["mine-profile", "mine-repo", "mine-all"] as const;

export type ReviewView = (typeof REVIEW_VIEWS)[number];
export type MyPrsView = (typeof MY_PRS_VIEWS)[number];
export type PrView = ReviewView | MyPrsView;

export const isReviewView = (v: unknown): v is ReviewView =>
	REVIEW_VIEWS.includes(v as ReviewView);
export const isMyPrsView = (v: unknown): v is MyPrsView =>
	MY_PRS_VIEWS.includes(v as MyPrsView);

/** How wide a net a PR view casts. `profile` is the default (ADR-0028):
 *  repositories the **Active profile**'s Workspaces resolve to. */
export type PrScope = "all" | "repo" | "profile";

export function scopeOf(view: PrView): PrScope {
	return view.endsWith("-repo")
		? "repo"
		: view.endsWith("-profile")
			? "profile"
			: "all";
}

/** Shape the PR sub-panel renders. Built from the raw store lists by the
 *  client-side All-vs-Repo selectors below — no longer a stored per-section
 *  slice (the app-global poller pushes one account-wide dataset). */
export interface PrSectionState {
	prs: PullRequest[];
	loading: boolean;
	error: string | null;
}

interface PrState {
	/** gh availability/auth, from the poller's pushed payload. Null until the
	 *  first `pr-state` / snapshot arrives. */
	ghStatus: GhStatus | null;
	/** Raw account-wide lists (every repo). The panel filters these client-side. */
	reviewRequested: PullRequest[];
	mine: PullRequest[];
	error: string | null;
	/** True until the first payload (snapshot or pushed event) lands. */
	loading: boolean;
	/** True from a manual Refresh request until the next poller payload lands.
	 *  Drives the spinning refresh icon. Distinct from `loading` (first-load
	 *  only) because `pr_poller_refresh` returns before the poll completes —
	 *  the spin must persist until the pushed `pr-state` clears it. */
	refreshing: boolean;
	/** The active workspace's GitHub `owner/repo` lowercased (see
	 *  `setActiveRepoSlug`), or null (no github remote / no active workspace).
	 *  Drives the repo-scoped filter and the repo-view "No GitHub remote found"
	 *  empty state. */
	activeRepoSlug: string | null;
	/** Every GitHub `owner/repo` the **Active profile**'s Workspaces resolve to,
	 *  lowercased. Pushed in by `useGitDataSync` from the batch workspace summary;
	 *  drives both the Profile-scoped filter and the Overview bar chips.
	 *  See ADR-0028. */
	profileRepoSlugs: Set<string>;
	/** False until the first batch summary lands — an empty set means "this
	 *  profile has no GitHub repositories" only once this is true. */
	repoSlugsResolved: boolean;

	reviewView: ReviewView;
	myPrsView: MyPrsView;

	applyPrState: (payload: PrStatePayload) => void;
	/** Mark a manual Refresh as in-flight (spins the refresh icon). Cleared by
	 *  the next `applyPrState`. */
	beginRefresh: () => void;
	setActiveRepoSlug: (slug: string | null) => void;
	/** `resolved` is list-aware: true once the batch summary has answered for
	 *  every Workspace currently listed (vacuously true for an empty Profile). */
	setProfileRepoSlugs: (slugs: Set<string>, resolved: boolean) => void;
	setReviewView: (view: ReviewView) => void;
	setMyPrsView: (view: MyPrsView) => void;
}

export const PR_VIEW_LABELS: Record<PrView, string> = {
	"review-profile": "Review Requested (Profile)",
	"review-repo": "Review Requested (Repo)",
	"review-all": "Review Requested (All)",
	"mine-profile": "My Open PRs (Profile)",
	"mine-repo": "My Open PRs (Repo)",
	"mine-all": "My Open PRs (All)",
};

export const usePrStore = create<PrState>()(
	persist(
		(set) => ({
			ghStatus: null,
			reviewRequested: [],
			mine: [],
			error: null,
			loading: true,
			refreshing: false,
			activeRepoSlug: null,
			profileRepoSlugs: new Set<string>(),
			repoSlugsResolved: false,
			reviewView: "review-profile",
			myPrsView: "mine-profile",

			applyPrState: (payload) => {
				const reviewRequested = payload.reviewRequested ?? [];
				const mine = payload.mine ?? [];
				set({
					ghStatus: {
						available: payload.available,
						authenticated: payload.authenticated,
					},
					reviewRequested,
					mine,
					error: payload.error ?? null,
					loading: false,
					refreshing: false,
				});
			},

			beginRefresh: () => set({ refreshing: true }),

			// Both slug setters lowercase on the way in. Slugs derived from git
			// remotes carry whatever casing sits in `.git/config` (GitHub accepts a
			// clone URL in any case), while `pr.repository` is GitHub's canonical
			// `nameWithOwner` — so a repo cloned as `Acme/Web` would match nothing
			// and the default view would look convincingly empty. Normalising here
			// rather than in the filter keeps the comparison allocation-free.
			setActiveRepoSlug: (slug) =>
				set({ activeRepoSlug: slug?.toLowerCase() ?? null }),

			setProfileRepoSlugs: (slugs, repoSlugsResolved) =>
				set((s) => {
					const profileRepoSlugs = new Set(
						[...slugs].map((x) => x.toLowerCase()),
					);
					// The pushing effect re-runs on every `workspaces` /
					// `repoSlugsById` identity change — including each batch summary
					// and each `workspacesApi.update(lastBranch)` round-trip. Writing
					// an identical-but-new Set would re-render the Overview bar and
					// the PR section and invalidate both `useMemo`s (the Set is a
					// dep) for no change at all.
					const unchanged =
						s.repoSlugsResolved === repoSlugsResolved &&
						s.profileRepoSlugs.size === profileRepoSlugs.size &&
						[...profileRepoSlugs].every((x) => s.profileRepoSlugs.has(x));
					return unchanged ? s : { profileRepoSlugs, repoSlugsResolved };
				}),
			setReviewView: (reviewView) => set({ reviewView }),
			setMyPrsView: (myPrsView) => set({ myPrsView }),
		}),
		{
			name: "abundio-pr-panel",
			// Only the per-section view preference persists; data is always
			// re-fetched by the poller on launch.
			partialize: (state) => ({
				reviewView: state.reviewView,
				myPrsView: state.myPrsView,
			}),
			// Profile is the default for **fresh installs only** (ADR-0028): it is
			// the store's initial state, and a stored preference always wins. A
			// scope is a deliberate per-section choice, so silently rewriting one
			// is worse than an existing user never noticing the new option.
			//
			// v1 marks the release that introduced the Profile scope; migrating
			// from v0 carries the stored views across untouched. The version stays
			// pinned rather than being removed so state written by the build that
			// briefly *did* reset isn't discarded (an unknown version with no
			// migrate falls back to initial state — a second reset).
			//
			// `migrate` below ignores its `version` argument because v0 is the only
			// version it can see today. A future bump must branch on it rather than
			// assume a blanket carry-across still fits — the version assertion in
			// the store's tests is there to make that decision explicit.
			version: 1,
			migrate: (persisted) => {
				// `persisted` is `unknown`: a stored value is honoured only if it is
				// still a view we ship. Anything else — hand-edited storage, or a
				// downgrade carrying a view added in a later version — would reach
				// `scopeOf` as "all" and silently widen the section to account-wide
				// (the one thing ADR-0028 says the Profile scope must never do),
				// and render a blank dropdown label from a missing `PR_VIEW_LABELS`
				// entry.
				const stored = (persisted ?? {}) as Record<string, unknown>;
				return {
					reviewView: isReviewView(stored.reviewView)
						? stored.reviewView
						: "review-profile",
					myPrsView: isMyPrsView(stored.myPrsView)
						? stored.myPrsView
						: "mine-profile",
				};
			},
		},
	),
);

// ── Client-side scope filter (single source of truth) ──
// One account-wide dataset from the poller, three scopes over it:
//   repo    → the Active workspace's repository. A null slug falls through to
//             the full list (the panel shows "No GitHub remote found" instead).
//   profile → the Active profile's repositories. An empty set yields an EMPTY
//             list, not the full one: "nothing matched" is the honest answer,
//             and the panel says so rather than silently widening the view.
//   all     → everything on the account.
// The panel passes its *effective* scope (a stored `-repo` degrades to
// `-profile` when no Workspace is Opened), so the rule lives here once. The
// Overview bar chips run the same rule via `profilePrCounts`, which is why they
// can never disagree with the section they summarise. See ADR-0028.

/** `activeRepoSlug` and `profileRepoSlugs` must already be lowercase — the
 *  store's setters guarantee it. `pr.repository` is lowercased per comparison so
 *  the PR keeps GitHub's canonical casing for display. */
export function visiblePrs(
	prs: PullRequest[],
	scope: PrScope,
	activeRepoSlug: string | null,
	profileRepoSlugs: Set<string>,
): PullRequest[] {
	if (scope === "repo") {
		return activeRepoSlug
			? prs.filter((pr) => pr.repository.toLowerCase() === activeRepoSlug)
			: prs;
	}
	if (scope === "profile") {
		return prs.filter((pr) =>
			profileRepoSlugs.has(pr.repository.toLowerCase()),
		);
	}
	return prs;
}

/** Profile-scoped counts for the Overview bar chips. Derived on every read
 *  rather than stored, because they depend on two independently-changing inputs
 *  — the poller payload and the repository set — and a cached total would drift
 *  whenever one moved without the other (the ADR-0020 lesson). */
export function profilePrCounts(state: {
	reviewRequested: PullRequest[];
	mine: PullRequest[];
	profileRepoSlugs: Set<string>;
}): { review: number; mine: number } {
	const slugs = state.profileRepoSlugs;
	return {
		review: visiblePrs(state.reviewRequested, "profile", null, slugs).length,
		mine: visiblePrs(state.mine, "profile", null, slugs).length,
	};
}

// ── PR change notifications ──
// The diff now runs in Rust (the poller), which emits `pr-changes` to a single
// Window. This handler renders those descriptors as OS notifications, gated on
// the same window-blur threshold as before — so notifications only fire while
// the app is backgrounded, and exactly once across all Windows.

export function handlePrChanges(changes: PrChange[]) {
	const blurredMs = getWindowBlurredMs();
	if (blurredMs === null || blurredMs < NOTIFICATION_BLUR_THRESHOLD_MS) return;

	const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
	for (const change of changes) {
		try {
			sendNotification({
				title: currentNotificationTitle(),
				body: change.body,
				extra: {
					type: "pr",
					...(activeWorkspaceId && { workspaceId: activeWorkspaceId }),
				},
			});
		} catch {
			// Notifications may not be permitted
		}
	}
}
