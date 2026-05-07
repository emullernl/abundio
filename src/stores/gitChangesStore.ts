import { create } from "zustand";
import { persist } from "zustand/middleware";
import { git, workspaces as workspacesApi } from "../lib/ipc";
import type { GitChangedFile } from "../lib/types";
import { useWorkspaceStore } from "./workspaceStore";
import { useWorkspaceGitStore } from "./workspaceGitStore";

let fetchGeneration = 0;
let lastFingerprint: string | null = null;

// Order-sensitive comparison — relies on the backend returning files in a
// stable order (against_base → staged → unstaged → untracked). This is
// guaranteed by the sequential section fetches in git_changed_files().
function filesEqual(a: GitChangedFile[], b: GitChangedFile[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (
			a[i].path !== b[i].path ||
			a[i].status !== b[i].status ||
			a[i].additions !== b[i].additions ||
			a[i].deletions !== b[i].deletions ||
			a[i].section !== b[i].section
		)
			return false;
	}
	return true;
}

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
	fetchChanges: (
		cwd: string,
		workspaceBaseBranch?: string | null,
	) => Promise<void>;
	refreshChanges: (
		cwd: string,
		workspaceBaseBranch?: string | null,
	) => Promise<void>;
	toggleSection: (section: string) => void;
	setBaseBranch: (
		workspaceId: string,
		branch: string | null,
		cwd: string,
	) => Promise<void>;
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

			fetchChanges: async (cwd, workspaceBaseBranch) => {
				const gen = ++fetchGeneration;
				// Only show loading spinner on first fetch — avoid flicker on refreshes
				if (get().changedFiles.length === 0 && !get().currentBranch) {
					set({ loading: true, error: null });
				} else {
					set({ error: null });
				}
				try {
					const [files, branchInfo, fingerprint] = await Promise.all([
						git.changedFiles(cwd, workspaceBaseBranch),
						git.branchInfo(cwd),
						git.statusFingerprint(cwd),
					]);
					if (gen !== fetchGeneration) return; // stale response
					lastFingerprint = fingerprint;
					const state = get();
					const newBaseBranch = workspaceBaseBranch || branchInfo.defaultBranch;
					const updates: Partial<GitChangesState> = { loading: false };
					if (!filesEqual(state.changedFiles, files)) {
						updates.changedFiles = files;
					}
					if (state.baseBranch !== newBaseBranch) {
						updates.baseBranch = newBaseBranch;
					}
					if (state.currentBranch !== branchInfo.currentBranch) {
						updates.currentBranch = branchInfo.currentBranch;
					}
					set(updates);
					// Keep sidebar chip and stats in sync without extra IPC calls
					const activeId = useWorkspaceStore.getState().activeWorkspaceId;
					if (activeId) {
						const totalAdd = files.reduce((s, f) => s + f.additions, 0);
						const totalDel = files.reduce((s, f) => s + f.deletions, 0);
						useWorkspaceGitStore.getState().setInfo(activeId, {
							isGitRepo: true,
							currentBranch: branchInfo.currentBranch,
							changedFileCount: files.length,
							additions: totalAdd,
							deletions: totalDel,
						});
						workspacesApi
							.update(activeId, { lastBranch: branchInfo.currentBranch })
							.catch(() => {});
					}
				} catch (e) {
					if (gen !== fetchGeneration) return; // stale response
					const errMsg = e instanceof Error ? e.message : String(e);
					set({
						loading: false,
						error: errMsg,
						changedFiles: [],
					});
					// Sync non-git status so sidebar chip and panel stay consistent
					if (/not a git repository/i.test(errMsg)) {
						const activeId = useWorkspaceStore.getState().activeWorkspaceId;
						if (activeId) {
							useWorkspaceGitStore.getState().setInfo(activeId, {
								isGitRepo: false,
								currentBranch: null,
								changedFileCount: 0,
								additions: 0,
								deletions: 0,
							});
						}
					}
				}
			},

			refreshChanges: async (cwd, workspaceBaseBranch) => {
				try {
					const fingerprint = await git.statusFingerprint(cwd);
					if (fingerprint === lastFingerprint) return;
					const gen = ++fetchGeneration;
					const files = await git.changedFiles(cwd, workspaceBaseBranch);
					if (gen !== fetchGeneration) return;
					lastFingerprint = fingerprint; // only commit once fetch succeeded
					const state = get();
					if (!filesEqual(state.changedFiles, files)) {
						set({ changedFiles: files });
					}
					// Keep sidebar chip and stats in sync
					const activeId = useWorkspaceStore.getState().activeWorkspaceId;
					if (activeId) {
						const totalAdd = files.reduce((s, f) => s + f.additions, 0);
						const totalDel = files.reduce((s, f) => s + f.deletions, 0);
						useWorkspaceGitStore.getState().setInfo(activeId, {
							isGitRepo: true,
							currentBranch: state.currentBranch,
							changedFileCount: files.length,
							additions: totalAdd,
							deletions: totalDel,
						});
					}
				} catch {
					// Fingerprint/refresh failures are non-critical
				}
			},

			toggleSection: (section) =>
				set((s) => ({
					collapsedSections: {
						...s.collapsedSections,
						[section]: !s.collapsedSections[section],
					},
				})),

			setBaseBranch: async (workspaceId, branch, cwd) => {
				await workspacesApi.update(workspaceId, { baseBranch: branch });
				useWorkspaceStore
					.getState()
					.setWorkspaceBaseBranch(workspaceId, branch);
				await get().fetchChanges(cwd, branch);
			},

			toggleBranchSelector: () =>
				set((s) => ({ branchSelectorOpen: !s.branchSelectorOpen })),
			closeBranchSelector: () => set({ branchSelectorOpen: false }),

			fetchBranches: async (cwd) => {
				try {
					const branches = await git.listBranches(cwd);
					set({ availableBranches: branches });
				} catch {
					set({ availableBranches: [] });
				}
			},

			clear: () => {
				lastFingerprint = null;
				set({
					changedFiles: [],
					baseBranch: null,
					currentBranch: null,
					availableBranches: [],
					loading: false,
					error: null,
					branchSelectorOpen: false,
				});
			},
		}),
		{
			name: "abundio-git-panel",
			partialize: (state) => ({ panelOpen: state.panelOpen }),
		},
	),
);
