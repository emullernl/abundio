import { sendNotification } from "@tauri-apps/plugin-notification";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { gh } from "../lib/ipc";
import type { GhStatus, PullRequest } from "../lib/types";
import { isAppWindowFocused } from "../lib/windowFocus";
import { useWorkspaceStore } from "./workspaceStore";

export type ReviewView = "review-all" | "review-repo";
export type MyPrsView = "mine-all" | "mine-repo";
export type PrView = ReviewView | MyPrsView;

export interface PrSectionState {
	prs: PullRequest[];
	loading: boolean;
	error: string | null;
}

interface PrState {
	ghStatus: GhStatus | null;

	reviewView: ReviewView;
	review: PrSectionState;

	myPrsView: MyPrsView;
	myPrs: PrSectionState;

	checkGhStatus: (cwd: string) => Promise<void>;
	fetchReviewPrs: (cwd: string) => Promise<void>;
	fetchMyPrs: (cwd: string) => Promise<void>;
	setReviewView: (view: ReviewView) => void;
	setMyPrsView: (view: MyPrsView) => void;
	clear: () => void;
}

export const PR_VIEW_LABELS: Record<PrView, string> = {
	"review-repo": "Review Requested (Repo)",
	"review-all": "Review Requested (All)",
	"mine-repo": "My Open PRs (Repo)",
	"mine-all": "My Open PRs (All)",
};

const EMPTY_SECTION: PrSectionState = {
	prs: [],
	loading: false,
	error: null,
};

export const usePrStore = create<PrState>()(
	persist(
		(set, get) => {
			let reviewGeneration = 0;
			let myPrsGeneration = 0;
			return {
				ghStatus: null,
				reviewView: "review-all",
				review: { ...EMPTY_SECTION },
				myPrsView: "mine-all",
				myPrs: { ...EMPTY_SECTION },

				checkGhStatus: async (cwd) => {
					try {
						const status = await gh.status(cwd);
						set({ ghStatus: status });
					} catch {
						set({
							ghStatus: {
								available: false,
								authenticated: false,
								hasRemote: false,
							},
						});
					}
				},

				fetchReviewPrs: async (cwd) => {
					const gen = ++reviewGeneration;
					set({ review: { ...get().review, loading: true, error: null } });

					try {
						const view = get().reviewView;
						const prs =
							view === "review-repo"
								? await gh.reviewRequests(cwd)
								: await gh.reviewRequestsAll(cwd);

						if (gen !== reviewGeneration) return;
						set({ review: { prs, loading: false, error: null } });
					} catch (e) {
						if (gen !== reviewGeneration) return;
						set({
							review: {
								prs: [],
								loading: false,
								error: e instanceof Error ? e.message : String(e),
							},
						});
					}
				},

				fetchMyPrs: async (cwd) => {
					const gen = ++myPrsGeneration;
					set({ myPrs: { ...get().myPrs, loading: true, error: null } });

					try {
						const view = get().myPrsView;
						const prs =
							view === "mine-repo"
								? await gh.myPrs(cwd)
								: await gh.myPrsAll(cwd);

						if (gen !== myPrsGeneration) return;
						set({ myPrs: { prs, loading: false, error: null } });
					} catch (e) {
						if (gen !== myPrsGeneration) return;
						set({
							myPrs: {
								prs: [],
								loading: false,
								error: e instanceof Error ? e.message : String(e),
							},
						});
					}
				},

				setReviewView: (view) => set({ reviewView: view }),
				setMyPrsView: (view) => set({ myPrsView: view }),

				clear: () =>
					set({
						review: { ...EMPTY_SECTION },
						myPrs: { ...EMPTY_SECTION },
					}),
			};
		},
		{
			name: "abundio-pr-panel",
			partialize: (state) => ({
				reviewView: state.reviewView,
				myPrsView: state.myPrsView,
			}),
		},
	),
);

// ── PR state change notifications ──

function prKey(pr: PullRequest): string {
	return `${pr.repository}#${pr.number}`;
}

function buildPrMap(prs: PullRequest[]): Map<string, PullRequest> {
	const map = new Map<string, PullRequest>();
	for (const pr of prs) {
		map.set(prKey(pr), pr);
	}
	return map;
}

let reviewHasLoaded = false;
let myPrsHasLoaded = false;
let skipNextReviewLoad = false;
let skipNextMyPrsLoad = false;

export function resetPrNotificationState() {
	reviewHasLoaded = false;
	myPrsHasLoaded = false;
	skipNextReviewLoad = false;
	skipNextMyPrsLoad = false;
}

usePrStore.subscribe((state, prevState) => {
	// Reset loaded flags when store is cleared
	if (
		state.review.prs.length === 0 &&
		!state.review.loading &&
		state.myPrs.prs.length === 0 &&
		!state.myPrs.loading &&
		(prevState.review.prs.length > 0 || prevState.myPrs.prs.length > 0)
	) {
		reviewHasLoaded = false;
		myPrsHasLoaded = false;
		return;
	}

	// Track view changes — skip the next load after a view switch
	if (prevState.reviewView !== state.reviewView) {
		skipNextReviewLoad = true;
	}
	if (prevState.myPrsView !== state.myPrsView) {
		skipNextMyPrsLoad = true;
	}

	if (isAppWindowFocused()) return;

	const notifications: string[] = [];

	// ── Review PRs: detect new review requests ──
	const reviewJustLoaded = prevState.review.loading && !state.review.loading;
	if (reviewJustLoaded) {
		if (!reviewHasLoaded) {
			reviewHasLoaded = true;
		} else if (skipNextReviewLoad) {
			skipNextReviewLoad = false;
		} else {
			const prevKeys = new Set(prevState.review.prs.map(prKey));
			for (const pr of state.review.prs) {
				if (!prevKeys.has(prKey(pr))) {
					notifications.push(`Review requested: ${pr.title} (#${pr.number})`);
				}
			}
		}
	}

	// ── My PRs: detect state transitions on existing PRs ──
	const myPrsJustLoaded = prevState.myPrs.loading && !state.myPrs.loading;
	if (myPrsJustLoaded) {
		if (!myPrsHasLoaded) {
			myPrsHasLoaded = true;
		} else if (skipNextMyPrsLoad) {
			skipNextMyPrsLoad = false;
		} else {
			const prevMap = buildPrMap(prevState.myPrs.prs);
			for (const pr of state.myPrs.prs) {
				const prev = prevMap.get(prKey(pr));
				if (!prev) continue; // New PR in my list — skip per requirements

				if (prev.reviewDecision !== pr.reviewDecision && pr.reviewDecision) {
					const label =
						pr.reviewDecision === "APPROVED"
							? "approved"
							: pr.reviewDecision === "CHANGES_REQUESTED"
								? "has changes requested"
								: `review: ${pr.reviewDecision.toLowerCase()}`;
					notifications.push(`#${pr.number} ${pr.title} — ${label}`);
				}

				if (
					prev.statusCheckRollup !== pr.statusCheckRollup &&
					pr.statusCheckRollup
				) {
					const label =
						pr.statusCheckRollup === "SUCCESS"
							? "CI passed"
							: pr.statusCheckRollup === "FAILURE"
								? "CI failed"
								: `CI: ${pr.statusCheckRollup.toLowerCase()}`;
					notifications.push(`#${pr.number} ${pr.title} — ${label}`);
				}
			}
		}
	}

	const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
	for (const body of notifications) {
		try {
			sendNotification({
				title: "Abundio",
				body,
				extra: {
					type: "pr",
					...(activeWorkspaceId && { workspaceId: activeWorkspaceId }),
				},
			});
		} catch {
			// Notifications may not be permitted
		}
	}
});
