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

export type ReviewView = "review-all" | "review-repo";
export type MyPrsView = "mine-all" | "mine-repo";
export type PrView = ReviewView | MyPrsView;

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
	/** The active workspace's GitHub `owner/repo`, or null (no github remote /
	 *  no active workspace). Drives the repo-scoped filter and the repo-view
	 *  "No GitHub remote found" empty state. */
	activeRepoSlug: string | null;

	reviewView: ReviewView;
	myPrsView: MyPrsView;

	/** Account-wide counts for the Overview bar — always the full list lengths,
	 *  independent of the panel's repo/all view (per ADR-0005). */
	globalReviewCount: number;
	globalMyPrsCount: number;

	applyPrState: (payload: PrStatePayload) => void;
	setActiveRepoSlug: (slug: string | null) => void;
	setReviewView: (view: ReviewView) => void;
	setMyPrsView: (view: MyPrsView) => void;
}

export const PR_VIEW_LABELS: Record<PrView, string> = {
	"review-repo": "Review Requested (Repo)",
	"review-all": "Review Requested (All)",
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
			activeRepoSlug: null,
			reviewView: "review-all",
			myPrsView: "mine-all",
			globalReviewCount: 0,
			globalMyPrsCount: 0,

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
					// Account-wide counts for the Overview bar chips.
					globalReviewCount: reviewRequested.length,
					globalMyPrsCount: mine.length,
				});
			},

			setActiveRepoSlug: (activeRepoSlug) => set({ activeRepoSlug }),
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
		},
	),
);

// ── Client-side All-vs-Repo filter (single source of truth) ──
// Repo-scoped view AND a known active repo → filter to it; otherwise (all view,
// or no active repo) the full account-wide list. The PR panel passes its
// *effective* view (which forces `-all` when no workspace is open), so the rule
// lives here once rather than being duplicated in the component. A repo view
// with a null slug naturally shows the `-all` data, which is why the
// empty-Opened-set state can simply force the `-all` label.

export function visiblePrs(
	prs: PullRequest[],
	isRepoView: boolean,
	activeRepoSlug: string | null,
): PullRequest[] {
	if (isRepoView && activeRepoSlug) {
		return prs.filter((pr) => pr.repository === activeRepoSlug);
	}
	return prs;
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
