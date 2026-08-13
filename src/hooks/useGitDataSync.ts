import { useEffect, useRef } from "react";
import { git, pr } from "../lib/ipc";
import {
	hasGitDataCachedFor,
	useGitChangesStore,
} from "../stores/gitChangesStore";
import { handlePrChanges, usePrStore } from "../stores/prStore";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import {
	profileRepoSlugs,
	repoSlugsResolvedFor,
	useWorkspaceGitStore,
} from "../stores/workspaceGitStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

interface SchedulerEntry {
	workspaceId: string;
	unlisten: (() => void) | null;
	cancelled: boolean;
}

/** Owns the per-opened-workspace `GitScheduler` lifecycle on the Rust side
 *  and the `git-state-<workspaceId>` listener that consumes the pushed
 *  bundles. Replaces the prior fs/git event-driven `fetchChanges`-on-every-event
 *  pattern that froze the JS main thread on `git stash` (because every
 *  `invoke` carries ~100-600ms of WKWebView main-thread overhead).
 *
 *  PR data is NOT fetched here anymore. The app-global Rust PR poller (ADR-0019)
 *  pushes `pr-state` to every Window; this hook just subscribes, hydrates from
 *  the cached snapshot on mount, and resolves the active workspace's repo slug
 *  for the client-side All-vs-Repo filter. */
export function useGitDataSync() {
	const openedWorkspaceIds = usePtyActivityStore((s) => s.openedWorkspaceIds);
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

	const activeRef = useRef<Map<string, SchedulerEntry>>(new Map());

	useEffect(() => {
		const active = activeRef.current;

		const desiredIds = new Set<string>();
		for (const wsId of openedWorkspaceIds) {
			const ws = workspaces.find((w) => w.id === wsId);
			if (ws?.rootFolder) desiredIds.add(wsId);
		}

		// Stop schedulers and unlisten for workspaces that are no longer Opened.
		for (const [wsId, entry] of active) {
			if (!desiredIds.has(wsId)) {
				entry.cancelled = true;
				entry.unlisten?.();
				git.schedulerStop(wsId).catch(() => {});
				active.delete(wsId);
			}
		}

		// Start schedulers + register listeners for newly-Opened workspaces.
		for (const wsId of desiredIds) {
			if (active.has(wsId)) continue;
			const ws = workspaces.find((w) => w.id === wsId);
			if (!ws?.rootFolder) continue;
			const cwd = ws.rootFolder;
			const baseBranch = ws.baseBranch ?? null;

			const entry: SchedulerEntry = {
				workspaceId: wsId,
				unlisten: null,
				cancelled: false,
			};
			active.set(wsId, entry);

			git.schedulerStart(wsId, cwd, baseBranch).catch((err) => {
				console.error("[useGitDataSync] schedulerStart failed:", err);
			});

			git
				.onGitState(wsId, (event) => {
					const store = useGitChangesStore.getState();
					if (event.kind === "bundle") {
						store.applyBundle(wsId, event.bundle);
					} else {
						store.applyError(wsId, event.message, event.notGitRepo);
					}
				})
				.then((unlisten) => {
					if (entry.cancelled) unlisten();
					else entry.unlisten = unlisten;
				})
				.catch((err) => {
					console.error("[useGitDataSync] onGitState listen failed:", err);
				});
		}
	}, [openedWorkspaceIds, workspaces]);

	// Cleanup on hook unmount — important for tests and for clean window-close.
	useEffect(() => {
		const active = activeRef.current;
		return () => {
			for (const [wsId, entry] of active) {
				entry.cancelled = true;
				entry.unlisten?.();
				git.schedulerStop(wsId).catch(() => {});
			}
			active.clear();
		};
	}, []);

	// ── App-global PR poller subscription (once per Window) ──
	// Hydrate immediately from the Rust-cached snapshot (no gh call), then
	// listen for pushed updates. `pr-changes` (notifications) is emitted to a
	// single Window by Rust, so registering the listener in every Window is safe.
	useEffect(() => {
		let cancelled = false;
		const unlisteners: Array<() => void> = [];

		pr.snapshot()
			.then((payload) => {
				if (cancelled || !payload) return;
				usePrStore.getState().applyPrState(payload);
			})
			.catch(() => {});

		pr.onPrState((payload) => usePrStore.getState().applyPrState(payload))
			.then((un) => {
				if (cancelled) un();
				else unlisteners.push(un);
			})
			.catch(() => {});

		pr.onPrChanges((changes) => handlePrChanges(changes))
			.then((un) => {
				if (cancelled) un();
				else unlisteners.push(un);
			})
			.catch(() => {});

		return () => {
			cancelled = true;
			for (const un of unlisteners) un();
		};
	}, []);

	// ── Profile-scoped repository set (ADR-0028) ──
	// The batch workspace summary (owned by `useWorktreeSync`) resolves every
	// Workspace's GitHub remotes; this collapses them to the set the PR filter
	// and the Overview bar chips read. Recomputed when either the workspace list
	// or the resolved slugs change, so adding a Workspace widens the set without
	// waiting for a poll.
	const repoSlugsById = useWorkspaceGitStore((s) => s.repoSlugsById);
	const workspacesInitialized = useWorkspaceStore(
		(s) => s.workspacesInitialized,
	);
	useEffect(() => {
		usePrStore
			.getState()
			.setProfileRepoSlugs(
				profileRepoSlugs(workspaces, repoSlugsById),
				repoSlugsResolvedFor(workspaces, repoSlugsById, workspacesInitialized),
			);
	}, [workspaces, repoSlugsById, workspacesInitialized]);

	const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
	const activeCwd = activeWorkspace?.rootFolder ?? null;
	const activeBaseBranch = activeWorkspace?.baseBranch ?? null;

	// Workspace-switch effect — hydrate git changes from cache, resolve the
	// active repo slug for the client-side PR filter, and cold-start a git
	// fetch only when no cache exists yet.
	useEffect(() => {
		useGitChangesStore.getState().hydrateFromWorkspace(activeWorkspaceId);

		if (!activeCwd) {
			// No active workspace folder → no repo to scope to. The PR panel
			// falls back to the account-wide (-all) view.
			usePrStore.getState().setActiveRepoSlug(null);
			return;
		}
		const cwd = activeCwd;
		const baseBranch = activeBaseBranch;
		const wsId = activeWorkspaceId;
		const cached = wsId ? hasGitDataCachedFor(wsId) : false;

		let cancelled = false;

		// Resolve the workspace's GitHub repo (owner/repo) for the repo-scoped
		// PR filter. Null when the workspace has no github remote.
		git
			.repoSlug(cwd)
			.then((slug) => {
				if (!cancelled) usePrStore.getState().setActiveRepoSlug(slug);
			})
			.catch(() => {
				if (!cancelled) usePrStore.getState().setActiveRepoSlug(null);
			});

		const rafId = requestAnimationFrame(() => {
			if (cancelled) return;
			if (!cached) {
				// Cold-start fallback — the scheduler's initial trigger covers
				// the same data within ~500ms; this only matters when it hasn't
				// pushed even once.
				useGitChangesStore.getState().fetchChanges(cwd, baseBranch);
			}
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(rafId);
		};
	}, [activeWorkspaceId, activeCwd, activeBaseBranch]);
}
