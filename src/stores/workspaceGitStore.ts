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
	/** Every GitHub `owner/repo` each workspace's remotes point at. Populated
	 *  from the batch `git_workspaces_summary`, which `useWorktreeSync` already
	 *  runs across the whole Active profile whenever the workspace list changes.
	 *  Raw per-workspace data — the *set* the PR filter uses is derived from the
	 *  current workspace list (see `profileRepoSlugs`), never from these keys, so
	 *  entries left behind by a profile switch can't leak in. See ADR-0028. */
	repoSlugsById: Record<string, string[]>;
	/** False until the first batch summary lands. Lets the PR section say
	 *  "Loading repositories…" instead of claiming the profile has none. */
	repoSlugsResolved: boolean;
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
	repoSlugsById: {},
	repoSlugsResolved: false,
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
		const slugs: Record<string, string[]> = {};
		for (const s of summaries) {
			updates[s.workspaceId] = {
				isGitRepo: s.isGitRepo,
				currentBranch: s.currentBranch ?? null,
				changedFileCount: s.changedFileCount,
				additions: s.additions,
				deletions: s.deletions,
			};
			slugs[s.workspaceId] = s.repoSlugs ?? [];
		}
		set((state) => ({
			byWorkspaceId: { ...state.byWorkspaceId, ...updates },
			repoSlugsById: { ...state.repoSlugsById, ...slugs },
			repoSlugsResolved: true,
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
			const { [workspaceId]: _s, ...restSlugs } = s.repoSlugsById;
			return {
				byWorkspaceId: rest,
				worktreeFacts: restFacts,
				repoSlugsById: restSlugs,
			};
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
			// Record "no slugs known" for the workspaces we asked about. The PR
			// section treats a missing entry as *unresolved* and shows a loading
			// message, so leaving them absent would hang that message forever on a
			// git-layer failure. An answer of "none" is terminal, and Refresh
			// retries. Grouping facts are deliberately left untouched.
			const empty: Record<string, string[]> = {};
			for (const r of requests) empty[r.workspaceId] = [];
			set((state) => ({
				repoSlugsById: { ...state.repoSlugsById, ...empty },
				repoSlugsResolved: true,
			}));
			return;
		}
		const facts: Record<string, WorktreeGroupFacts> = {};
		const slugs: Record<string, string[]> = {};
		for (const s of summaries) {
			facts[s.workspaceId] = {
				worktreeGroupKey: s.worktreeGroupKey,
				isMainWorktree: s.isMainWorktree,
				worktreeRoot: s.worktreeRoot,
			};
			slugs[s.workspaceId] = s.repoSlugs ?? [];
		}
		set((state) => ({
			worktreeFacts: { ...state.worktreeFacts, ...facts },
			repoSlugsById: { ...state.repoSlugsById, ...slugs },
			repoSlugsResolved: true,
		}));
	},

	setWorktreeFacts: (workspaceId, facts) =>
		set((s) => ({
			worktreeFacts: { ...s.worktreeFacts, [workspaceId]: facts },
		})),
}));

/** The set of GitHub repositories the given Workspaces resolve to — the input
 *  to the Profile-scoped PR filter (ADR-0028).
 *
 *  Driven by the *workspace list*, not by the keys of `repoSlugsById`: switching
 *  Profile reloads the list but leaves the old map entries in place, and those
 *  must not widen the filter. Several Workspaces of one **Worktree set** collapse
 *  to the same slug, and one Workspace can contribute several (fork + upstream). */
/** Whether the repository set is a real answer for *this* Workspace list.
 *
 *  List-aware on purpose. A single global "resolved" flag goes stale twice
 *  over: a Profile switch brings in Workspaces the previous profile's summary
 *  never covered (so the panel would flash "no repositories"), and a Profile
 *  with no Workspaces never triggers a summary at all (so the panel would hang
 *  on "loading" forever — here it resolves vacuously to the empty set). */
export function repoSlugsResolvedFor(
	workspaces: { id: string }[],
	repoSlugsById: Record<string, string[]>,
	workspacesInitialized: boolean,
): boolean {
	if (!workspacesInitialized) return false;
	return workspaces.every((ws) => repoSlugsById[ws.id] !== undefined);
}

export function profileRepoSlugs(
	workspaces: { id: string }[],
	repoSlugsById: Record<string, string[]>,
): Set<string> {
	const set = new Set<string>();
	for (const ws of workspaces) {
		for (const slug of repoSlugsById[ws.id] ?? []) set.add(slug);
	}
	return set;
}
