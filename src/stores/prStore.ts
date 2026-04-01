import { create } from "zustand";
import { persist } from "zustand/middleware";
import { gh } from "../lib/ipc";
import type { GhStatus, PullRequest } from "../lib/types";

export type PrView = "review-repo" | "review-all" | "mine-repo" | "mine-all";

interface PrState {
	ghStatus: GhStatus | null;
	activeView: PrView;
	prs: PullRequest[];
	loading: boolean;
	error: string | null;

	checkGhStatus: (cwd: string) => Promise<void>;
	fetchPrs: (cwd: string) => Promise<void>;
	setActiveView: (view: PrView) => void;
	clear: () => void;
}

export const PR_VIEW_LABELS: Record<PrView, string> = {
	"review-repo": "Review Requested (Repo)",
	"review-all": "Review Requested (All)",
	"mine-repo": "My Open PRs (Repo)",
	"mine-all": "My Open PRs (All)",
};

export const usePrStore = create<PrState>()(
	persist(
		(set, get) => {
			let fetchGeneration = 0;
			return {
			ghStatus: null,
			activeView: "review-all",
			prs: [],
			loading: false,
			error: null,

			checkGhStatus: async (cwd) => {
				try {
					const status = await gh.status(cwd);
					set({ ghStatus: status });
				} catch {
					set({
						ghStatus: { available: false, authenticated: false, hasRemote: false },
					});
				}
			},

			fetchPrs: async (cwd) => {
				const gen = ++fetchGeneration;
				set({ loading: true, error: null });

				try {
					const view = get().activeView;
					let prs: PullRequest[];

					switch (view) {
						case "review-repo":
							prs = await gh.reviewRequests(cwd);
							break;
						case "review-all":
							prs = await gh.reviewRequestsAll(cwd);
							break;
						case "mine-repo":
							prs = await gh.myPrs(cwd);
							break;
						case "mine-all":
							prs = await gh.myPrsAll(cwd);
							break;
					}

					if (gen !== fetchGeneration) return;
					set({ prs, loading: false });
				} catch (e) {
					if (gen !== fetchGeneration) return;
					set({
						loading: false,
						error: e instanceof Error ? e.message : String(e),
						prs: [],
					});
				}
			},

			setActiveView: (view) => set({ activeView: view }),

			clear: () =>
				set({
					prs: [],
					loading: false,
					error: null,
				}),
		};
		},
		{
			name: "abundio-pr-panel",
			partialize: (state) => ({ activeView: state.activeView }),
		},
	),
);
