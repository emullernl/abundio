import { create } from "zustand";
import {
	git,
	type WorkspaceGitSummary,
	workspaces as workspacesApi,
} from "../lib/ipc";
import type { WorktreeGroupFacts } from "../lib/worktreeGrouping";

export type WorkspaceGitInfo = {
	isGitRepo: boolean;
	currentBranch: string | null;
	changedFileCount: number;
	additions: number;
	deletions: number;
};

interface WorkspaceGitState {
	byWorkspaceId: Record<string, WorkspaceGitInfo>;
	/** Worktree grouping facts per workspace, kept separate from the branch-chip
	 *  info above so its many writers (fetch / setInfo / scheduler) can't clobber
	 *  it. Populated only from the batch `git_workspaces_summary`. See ADR-0017. */
	worktreeFacts: Record<string, WorktreeGroupFacts>;
	inFlight: Set<string>;
	fetch: (
		workspaceId: string,
		cwd: string,
		baseBranch?: string | null,
	) => Promise<void>;
	fetchAll: (
		workspaces: {
			id: string;
			rootFolder: string;
			baseBranch?: string | null;
		}[],
	) => Promise<void>;
	refreshWorkspace: (
		workspaceId: string,
		cwd: string,
		baseBranch?: string | null,
	) => Promise<void>;
	setInfo: (workspaceId: string, info: WorkspaceGitInfo) => void;
	remove: (workspaceId: string) => void;
	/** Refresh worktree grouping facts for the given workspaces via one batched
	 *  summary IPC. Called whenever the workspace list changes. */
	syncWorktreeFacts: (
		workspaces: {
			id: string;
			rootFolder: string;
			baseBranch?: string | null;
		}[],
	) => Promise<void>;
	setWorktreeFacts: (workspaceId: string, facts: WorktreeGroupFacts) => void;
}

export const useWorkspaceGitStore = create<WorkspaceGitState>((set, _get) => ({
	byWorkspaceId: {},
	worktreeFacts: {},
	inFlight: new Set(),

	fetch: async (workspaceId, cwd, baseBranch) => {
		set((s) => ({ inFlight: new Set([...s.inFlight, workspaceId]) }));
		try {
			const [branchInfo, files] = await Promise.all([
				git.branchInfo(cwd),
				git.changedFiles(cwd, baseBranch ?? null).catch(() => []),
			]);
			const additions = files.reduce((s, f) => s + f.additions, 0);
			const deletions = files.reduce((s, f) => s + f.deletions, 0);
			set((s) => ({
				byWorkspaceId: {
					...s.byWorkspaceId,
					[workspaceId]: {
						isGitRepo: true,
						currentBranch: branchInfo.currentBranch,
						changedFileCount: files.length,
						additions,
						deletions,
					},
				},
				inFlight: new Set([...s.inFlight].filter((id) => id !== workspaceId)),
			}));
			workspacesApi
				.update(workspaceId, { lastBranch: branchInfo.currentBranch })
				.catch(() => {});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/not a git repository/i.test(msg)) {
				set((s) => ({
					byWorkspaceId: {
						...s.byWorkspaceId,
						[workspaceId]: {
							isGitRepo: false,
							currentBranch: null,
							changedFileCount: 0,
							additions: 0,
							deletions: 0,
						},
					},
					inFlight: new Set([...s.inFlight].filter((id) => id !== workspaceId)),
				}));
			} else {
				// Non-git error (e.g. git not installed) — leave existing entry, clear inFlight
				set((s) => ({
					inFlight: new Set([...s.inFlight].filter((id) => id !== workspaceId)),
				}));
			}
		}
	},

	fetchAll: async (workspaces) => {
		if (workspaces.length === 0) return;
		const requests = workspaces.map((ws) => ({
			workspaceId: ws.id,
			cwd: ws.rootFolder,
			baseBranch: ws.baseBranch ?? null,
		}));
		let summaries: WorkspaceGitSummary[];
		try {
			summaries = await git.workspacesSummary(requests);
		} catch {
			return;
		}
		// Single state update for all workspaces at once — one React render cycle
		const updates: Record<string, WorkspaceGitInfo> = {};
		for (const s of summaries) {
			updates[s.workspaceId] = {
				isGitRepo: s.isGitRepo,
				currentBranch: s.currentBranch ?? null,
				changedFileCount: s.changedFileCount,
				additions: s.additions,
				deletions: s.deletions,
			};
		}
		set((state) => ({
			byWorkspaceId: { ...state.byWorkspaceId, ...updates },
		}));
		// Persist the refreshed branch names so the next startup is instant.
		// Sequential to avoid saturating the tokio worker threads with
		// concurrent sync SQLite calls (workspace_update runs without spawn_blocking).
		for (const s of summaries) {
			if (s.isGitRepo && s.currentBranch) {
				await workspacesApi
					.update(s.workspaceId, { lastBranch: s.currentBranch })
					.catch(() => {});
			}
		}
	},

	refreshWorkspace: async (workspaceId, cwd, baseBranch) => {
		try {
			const files = await git.changedFiles(cwd, baseBranch ?? null);
			const additions = files.reduce((s, f) => s + f.additions, 0);
			const deletions = files.reduce((s, f) => s + f.deletions, 0);
			set((s) => {
				const existing = s.byWorkspaceId[workspaceId];
				if (!existing) return s;
				return {
					byWorkspaceId: {
						...s.byWorkspaceId,
						[workspaceId]: {
							...existing,
							changedFileCount: files.length,
							additions,
							deletions,
						},
					},
				};
			});
		} catch {
			// Background refresh failures are non-critical
		}
	},

	setInfo: (workspaceId, info) =>
		set((s) => ({
			byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: info },
		})),

	remove: (workspaceId) => {
		set((s) => {
			const { [workspaceId]: _removed, ...rest } = s.byWorkspaceId;
			const { [workspaceId]: _f, ...restFacts } = s.worktreeFacts;
			return { byWorkspaceId: rest, worktreeFacts: restFacts };
		});
	},

	syncWorktreeFacts: async (workspaces) => {
		if (workspaces.length === 0) return;
		const requests = workspaces.map((ws) => ({
			workspaceId: ws.id,
			cwd: ws.rootFolder,
			baseBranch: ws.baseBranch ?? null,
		}));
		let summaries: WorkspaceGitSummary[];
		try {
			summaries = await git.workspacesSummary(requests);
		} catch {
			return;
		}
		const facts: Record<string, WorktreeGroupFacts> = {};
		for (const s of summaries) {
			facts[s.workspaceId] = {
				worktreeGroupKey: s.worktreeGroupKey,
				isMainWorktree: s.isMainWorktree,
			};
		}
		set((state) => ({
			worktreeFacts: { ...state.worktreeFacts, ...facts },
		}));
	},

	setWorktreeFacts: (workspaceId, facts) =>
		set((s) => ({
			worktreeFacts: { ...s.worktreeFacts, [workspaceId]: facts },
		})),
}));
