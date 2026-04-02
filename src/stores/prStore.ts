import { create } from "zustand";
import { persist } from "zustand/middleware";
import { gh } from "../lib/ipc";
import type { GhStatus, PullRequest } from "../lib/types";

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
