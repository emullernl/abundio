import { create } from "zustand";
import { persist } from "zustand/middleware";
import { git, sessions as sessionsApi } from "../lib/ipc";
import { useSessionStore } from "./sessionStore";
import type { GitChangedFile } from "../lib/types";

let fetchGeneration = 0;

interface GitChangesState {
	panelOpen: boolean;
	changedFiles: GitChangedFile[];
	baseBranch: string | null;
	currentBranch: string | null;
	availableBranches: string[];
	loading: boolean;
	error: string | null;
	collapsedSections: Record<string, boolean>;
	branchSelectorOpen: boolean;

	togglePanel: () => void;
	setPanel: (open: boolean) => void;
	fetchChanges: (cwd: string, sessionBaseBranch?: string | null) => Promise<void>;
	toggleSection: (section: string) => void;
	setBaseBranch: (sessionId: string, branch: string | null, cwd: string) => Promise<void>;
	toggleBranchSelector: () => void;
	closeBranchSelector: () => void;
	fetchBranches: (cwd: string) => Promise<void>;
	clear: () => void;
}

export const useGitChangesStore = create<GitChangesState>()(
	persist(
		(set, get) => ({
			panelOpen: false,
			changedFiles: [],
			baseBranch: null,
			currentBranch: null,
			availableBranches: [],
			loading: false,
			error: null,
			collapsedSections: {},
			branchSelectorOpen: false,

			togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
			setPanel: (open) => set({ panelOpen: open }),

			fetchChanges: async (cwd, sessionBaseBranch) => {
				const gen = ++fetchGeneration;
				set({ loading: true, error: null });
				try {
					const [files, branchInfo] = await Promise.all([
						git.changedFiles(cwd, sessionBaseBranch),
						git.branchInfo(cwd),
					]);
					if (gen !== fetchGeneration) return; // stale response
					set({
						changedFiles: files,
						baseBranch: sessionBaseBranch || branchInfo.defaultBranch,
						currentBranch: branchInfo.currentBranch,
						loading: false,
					});
				} catch (e) {
					if (gen !== fetchGeneration) return; // stale response
					set({
						loading: false,
						error: e instanceof Error ? e.message : String(e),
						changedFiles: [],
					});
				}
			},

			toggleSection: (section) =>
				set((s) => ({
					collapsedSections: {
						...s.collapsedSections,
						[section]: !s.collapsedSections[section],
					},
				})),

			setBaseBranch: async (sessionId, branch, cwd) => {
				await sessionsApi.update(sessionId, { baseBranch: branch });
				useSessionStore.getState().setSessionBaseBranch(sessionId, branch);
				await get().fetchChanges(cwd, branch);
			},

			toggleBranchSelector: () => set((s) => ({ branchSelectorOpen: !s.branchSelectorOpen })),
			closeBranchSelector: () => set({ branchSelectorOpen: false }),

			fetchBranches: async (cwd) => {
				try {
					const branches = await git.listBranches(cwd);
					set({ availableBranches: branches });
				} catch {
					set({ availableBranches: [] });
				}
			},

			clear: () =>
				set({
					changedFiles: [],
					baseBranch: null,
					currentBranch: null,
					availableBranches: [],
					loading: false,
					error: null,
					branchSelectorOpen: false,
				}),
		}),
		{
			name: "abundio-git-panel",
			partialize: (state) => ({ panelOpen: state.panelOpen }),
		},
	),
);
