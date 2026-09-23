import { create } from "zustand";
import { branchStatOf } from "../lib/dirtyWorkspace";
import {
	type GitFetchBundle,
	type GitOperation,
	git,
	workspaces as workspacesApi,
} from "../lib/ipc";
import type { CommitHistory, GitChangedFile } from "../lib/types";
import { conflictedPathsOf, useWorkspaceGitStore } from "./workspaceGitStore";
import { useWorkspaceStore } from "./workspaceStore";

let fetchGeneration = 0;

// Single-flight guards. With WKWebView IPC having ~100-200ms per-call
// main-thread overhead, firing concurrent fetches (e.g. fs-change AND
// git-change both triggering during a `git stash`) compounds the freeze.
// These ensure at most one of each is in flight; concurrent callers reuse
// the in-flight promise instead of starting a new fetch.
let inFlightFetch: Promise<void> | null = null;

// Per-workspace cache so that switching workspaces can hydrate the singleton
// instantly from prior data instead of clearing-then-refetching. Kept in
// module memory (not persisted) — data is refetched on next switch anyway.
interface GitChangesCacheEntry {
	changedFiles: GitChangedFile[];
	baseBranch: string | null;
	currentBranch: string | null;
	availableBranches: string[];
	operationInProgress: GitOperation | null;
	commitHistory: CommitHistory | null;
}

const gitChangesCache = new Map<string, GitChangesCacheEntry>();

/** Cache-presence probe used by `useGitDataSync`'s workspace-switch effect.
 *  Returns true when we've previously stored a bundle for this workspace —
 *  meaning the scheduler has pushed at least once and the cache will hydrate
 *  the singleton without a fallback `fetchChanges` invoke. */
export function hasGitDataCachedFor(workspaceId: string): boolean {
	return gitChangesCache.has(workspaceId);
}

function emptyCacheEntry(): GitChangesCacheEntry {
	return {
		changedFiles: [],
		baseBranch: null,
		currentBranch: null,
		availableBranches: [],
		operationInProgress: null,
		commitHistory: null,
	};
}

/** Same list, same order, same remote reachability. A bundle push on every
 *  fs event must not re-render the section when nothing about it moved. */
export function commitHistoryEqual(
	a: CommitHistory | null,
	b: CommitHistory | null,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.base !== b.base || a.total !== b.total) return false;
	if (a.githubSlug !== b.githubSlug) return false;
	if (a.commits.length !== b.commits.length) return false;
	for (let i = 0; i < a.commits.length; i++) {
		if (
			a.commits[i].oid !== b.commits[i].oid ||
			a.commits[i].onRemote !== b.commits[i].onRemote
		)
			return false;
	}
	return true;
}

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
	changedFiles: GitChangedFile[];
	baseBranch: string | null;
	currentBranch: string | null;
	availableBranches: string[];
	loading: boolean;
	error: string | null;
	collapsedSections: Record<string, boolean>;
	branchSelectorOpen: boolean;
	/** The suspended git operation, surfaced as a single read-only line in the
	 *  Git changes tab. Abundio never continues or aborts one. */
	operationInProgress: GitOperation | null;
	/** The **Commits** section's data for the Active workspace. Null
	 *  before the first bundle, or when the base branch cannot be resolved. */
	commitHistory: CommitHistory | null;
	fetchChanges: (
		cwd: string,
		workspaceBaseBranch?: string | null,
	) => Promise<void>;
	/** Apply a Rust-pushed bundle to the per-workspace caches and (if it's
	 *  for the active workspace) the singleton store. The primary update path
	 *  in the new push architecture — see `git_scheduler.rs` and the
	 *  `git-state-<workspaceId>` event handler in `useGitDataSync`. */
	applyBundle: (workspaceId: string, bundle: GitFetchBundle) => void;
	/** Apply a Rust-pushed error. `notGitRepo === true` triggers the
	 *  `NotAGitRepoEmpty` empty state via `workspaceGitStore.setInfo`. */
	applyError: (
		workspaceId: string,
		message: string,
		notGitRepo: boolean,
	) => void;
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
	hydrateFromWorkspace: (workspaceId: string | null) => void;
}

export const useGitChangesStore = create<GitChangesState>()((set, get) => ({
	changedFiles: [],
	baseBranch: null,
	currentBranch: null,
	availableBranches: [],
	loading: false,
	error: null,
	collapsedSections: {},
	branchSelectorOpen: false,
	operationInProgress: null,
	commitHistory: null,

	fetchChanges: async (cwd, workspaceBaseBranch) => {
		if (inFlightFetch) {
			return inFlightFetch;
		}
		let resolveInFlight: () => void = () => {};
		inFlightFetch = new Promise<void>((res) => {
			resolveInFlight = res;
		});
		// Capture the workspace that owns this fetch. The cache is keyed by
		// this id so a fetch that started for A still populates cache[A]
		// even if the user has since switched to B (the gen check guards
		// the singleton update, not the cache write).
		const startedForWorkspaceId =
			useWorkspaceStore.getState().activeWorkspaceId;
		const gen = ++fetchGeneration;
		// Only show loading spinner on first fetch — avoid flicker on refreshes
		if (get().changedFiles.length === 0 && !get().currentBranch) {
			set({ loading: true, error: null });
		} else {
			set({ error: null });
		}
		try {
			const bundle = await git.fetchBundle(cwd, workspaceBaseBranch);
			const files = bundle.changedFiles;
			const branchInfo = bundle.branchInfo;
			const newBaseBranch = workspaceBaseBranch || branchInfo.defaultBranch;
			if (startedForWorkspaceId) {
				const existing =
					gitChangesCache.get(startedForWorkspaceId) ?? emptyCacheEntry();
				gitChangesCache.set(startedForWorkspaceId, {
					...existing,
					changedFiles: files,
					baseBranch: newBaseBranch,
					currentBranch: branchInfo.currentBranch,
					commitHistory: bundle.commitHistory,
				});
			}
			if (gen !== fetchGeneration) return; // stale singleton
			// Don't write A's changes into the singleton if the user has
			// switched to B and B's fetch was skipped by the freshness gate
			// (so fetchGeneration was never bumped past A's gen).
			if (
				startedForWorkspaceId !== useWorkspaceStore.getState().activeWorkspaceId
			)
				return;
			const state = get();
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
			if (!commitHistoryEqual(state.commitHistory, bundle.commitHistory)) {
				updates.commitHistory = bundle.commitHistory;
			}
			set(updates);
			// Keep sidebar chip and stats in sync without extra IPC calls
			const activeId = useWorkspaceStore.getState().activeWorkspaceId;
			if (activeId) {
				const wtStore = useWorkspaceGitStore.getState();
				wtStore.setInfo(activeId, {
					conflictedPaths: conflictedPathsOf(files),
					isGitRepo: true,
					currentBranch: branchInfo.currentBranch,
					...branchStatOf(files),
				});
				wtStore.setLiveUncommitted(activeId, files);
				workspacesApi
					.update(activeId, { lastBranch: branchInfo.currentBranch })
					.catch(() => {});
			}
		} catch (e) {
			// Same rule as `applyError`: a failed refresh's commit list is stale,
			// in the cache too, or a switch away and back would resurrect it.
			// Before the generation check, as the success path writes the cache
			// before it: the cache belongs to the workspace, not the singleton.
			if (startedForWorkspaceId) {
				const existing = gitChangesCache.get(startedForWorkspaceId);
				if (existing) {
					gitChangesCache.set(startedForWorkspaceId, {
						...existing,
						commitHistory: null,
					});
				}
			}
			if (gen !== fetchGeneration) return; // stale response
			const errMsg = e instanceof Error ? e.message : String(e);
			set({
				loading: false,
				error: errMsg,
				changedFiles: [],
				commitHistory: null,
			});
			// Sync non-git status so sidebar chip and panel stay consistent
			if (/not a git repository/i.test(errMsg)) {
				const activeId = useWorkspaceStore.getState().activeWorkspaceId;
				if (activeId) {
					const wtStore = useWorkspaceGitStore.getState();
					wtStore.setInfo(activeId, {
						conflictedPaths: [],
						isGitRepo: false,
						currentBranch: null,
						changedFileCount: 0,
						additions: 0,
						deletions: 0,
					});
					wtStore.clearUncommitted(activeId);
				}
			}
		} finally {
			inFlightFetch = null;
			resolveInFlight();
		}
	},

	applyBundle: (workspaceId, bundle) => {
		const files = bundle.changedFiles;
		const branchInfo = bundle.branchInfo;
		const wsState = useWorkspaceStore.getState();
		const workspace = wsState.workspaces.find((w) => w.id === workspaceId);
		const workspaceBaseBranch = workspace?.baseBranch ?? null;
		const newBaseBranch = workspaceBaseBranch || branchInfo.defaultBranch;

		// Always: cache + fingerprint, so hydrateFromWorkspace works correctly
		// when this workspace becomes active later.
		const existing = gitChangesCache.get(workspaceId) ?? emptyCacheEntry();
		const prevCurrentBranch = existing.currentBranch;
		gitChangesCache.set(workspaceId, {
			...existing,
			changedFiles: files,
			baseBranch: newBaseBranch,
			currentBranch: branchInfo.currentBranch,
			operationInProgress: bundle.operationInProgress,
			commitHistory: bundle.commitHistory,
		});

		// Always: sidebar chip — keeps WorkspaceItem accurate for background
		// workspaces too (per the unified-dispatch decision in the plan).
		const chipStore = useWorkspaceGitStore.getState();
		chipStore.setInfo(workspaceId, {
			conflictedPaths: conflictedPathsOf(files),
			isGitRepo: true,
			currentBranch: branchInfo.currentBranch,
			...branchStatOf(files),
		});
		chipStore.setLiveUncommitted(workspaceId, files);
		// Persist the branch to the workspace_store, but ONLY when it actually
		// changed. Every `invoke` carries ~100-1000 ms of WKWebView main-thread
		// overhead in this app, and the scheduler pushes a bundle on every
		// fs/git event during a `git stash` burst — firing this on every
		// push was the residual freeze after the architectural pivot. The
		// branch rarely changes; gating on diff drops this to ~0 invokes/burst.
		if (branchInfo.currentBranch !== prevCurrentBranch) {
			workspacesApi
				.update(workspaceId, { lastBranch: branchInfo.currentBranch })
				.catch(() => {});
		}

		// Refresh worktree grouping facts when this folder wasn't recognized as
		// a git worktree yet — e.g. the user ran `git init` in a folder that
		// wasn't a repo when the Workspace opened. The scheduler now reports a
		// successful bundle, so re-run the batched summary to populate
		// `isMainWorktree`/`worktreeGroupKey` and surface the "Add worktree"
		// affordance without reopening the Workspace. Gated on the missing group
		// key so it fires once per non-git→git transition, not on every push.
		const wtStore = useWorkspaceGitStore.getState();
		if (workspace && !wtStore.worktreeFacts[workspaceId]?.worktreeGroupKey) {
			wtStore.syncWorktreeFacts([
				{
					id: workspaceId,
					rootFolder: workspace.rootFolder,
					baseBranch: workspaceBaseBranch,
				},
			]);
		}

		// Singleton: only when this bundle is for the active workspace.
		// Background-workspace pushes update the per-workspace caches above
		// without disturbing what's currently visible in the Git changes tab.
		if (workspaceId !== wsState.activeWorkspaceId) {
			return;
		}
		const state = get();
		const updates: Partial<GitChangesState> = { loading: false, error: null };
		if (!filesEqual(state.changedFiles, files)) {
			updates.changedFiles = files;
		}
		if (state.baseBranch !== newBaseBranch) {
			updates.baseBranch = newBaseBranch;
		}
		if (state.currentBranch !== branchInfo.currentBranch) {
			updates.currentBranch = branchInfo.currentBranch;
		}
		if (state.operationInProgress !== bundle.operationInProgress) {
			updates.operationInProgress = bundle.operationInProgress;
		}
		if (!commitHistoryEqual(state.commitHistory, bundle.commitHistory)) {
			updates.commitHistory = bundle.commitHistory;
		}
		set(updates);
	},

	applyError: (workspaceId, message, notGitRepo) => {
		if (notGitRepo) {
			const wtStore = useWorkspaceGitStore.getState();
			wtStore.setInfo(workspaceId, {
				conflictedPaths: [],
				isGitRepo: false,
				currentBranch: null,
				changedFileCount: 0,
				additions: 0,
				deletions: 0,
			});
			wtStore.clearUncommitted(workspaceId);
			// Symmetric to applyBundle: a folder that's no longer a repo (e.g.
			// `.git` was removed mid-session) must drop its stale worktree facts
			// so the "Add worktree" affordance disappears. Gated on a still-held
			// group key so it fires once per git→non-git transition.
			if (wtStore.worktreeFacts[workspaceId]?.worktreeGroupKey) {
				const ws = useWorkspaceStore
					.getState()
					.workspaces.find((w) => w.id === workspaceId);
				if (ws) {
					wtStore.syncWorktreeFacts([
						{
							id: workspaceId,
							rootFolder: ws.rootFolder,
							baseBranch: ws.baseBranch ?? null,
						},
					]);
				}
			}
		}
		// The bundle failed, so its commit list is stale too; drop it from the
		// cache as well, or a switch away and back would resurrect it.
		const existing = gitChangesCache.get(workspaceId);
		if (existing) {
			gitChangesCache.set(workspaceId, { ...existing, commitHistory: null });
		}
		const activeId = useWorkspaceStore.getState().activeWorkspaceId;
		if (workspaceId !== activeId) return;
		set({
			loading: false,
			error: message,
			changedFiles: [],
			commitHistory: null,
		});
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
		useWorkspaceStore.getState().setWorkspaceBaseBranch(workspaceId, branch);
		// Restart the per-workspace scheduler with the new baseBranch.
		// The scheduler holds baseBranch immutable for its lifetime — restart
		// is the supported way to change it (no internal mutex/setter), and
		// `start` fires an immediate fetch so the panel refreshes without
		// going through the slow `invoke`-based path.
		await git.schedulerStop(workspaceId);
		await git.schedulerStart(workspaceId, cwd, branch);
	},

	toggleBranchSelector: () =>
		set((s) => ({ branchSelectorOpen: !s.branchSelectorOpen })),
	closeBranchSelector: () => set({ branchSelectorOpen: false }),

	fetchBranches: async (cwd) => {
		const startedForWorkspaceId =
			useWorkspaceStore.getState().activeWorkspaceId;
		try {
			const branches = await git.listBranches(cwd);
			if (startedForWorkspaceId) {
				const existing =
					gitChangesCache.get(startedForWorkspaceId) ?? emptyCacheEntry();
				gitChangesCache.set(startedForWorkspaceId, {
					...existing,
					availableBranches: branches,
				});
			}
			set({ availableBranches: branches });
		} catch {
			set({ availableBranches: [] });
		}
	},

	clear: () => {
		set({
			changedFiles: [],
			baseBranch: null,
			currentBranch: null,
			availableBranches: [],
			operationInProgress: null,
			commitHistory: null,
			loading: false,
			error: null,
			branchSelectorOpen: false,
		});
	},

	hydrateFromWorkspace: (workspaceId) => {
		const entry = workspaceId ? gitChangesCache.get(workspaceId) : undefined;
		set({
			changedFiles: entry?.changedFiles ?? [],
			baseBranch: entry?.baseBranch ?? null,
			currentBranch: entry?.currentBranch ?? null,
			availableBranches: entry?.availableBranches ?? [],
			operationInProgress: entry?.operationInProgress ?? null,
			commitHistory: entry?.commitHistory ?? null,
			loading: false,
			error: null,
			branchSelectorOpen: false,
		});
	},
}));
