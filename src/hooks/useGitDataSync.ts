import { useEffect, useRef } from "react";
import { git } from "../lib/ipc";
import {
	hasGitDataCachedFor,
	useGitChangesStore,
} from "../stores/gitChangesStore";
import { usePrStore } from "../stores/prStore";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useWindowUiStore } from "../stores/windowUiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

const GH_OPEN_MS = 60_000;
const GH_COLLAPSED_MS = 60_000;

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
 *  The lifecycle tracks `openedWorkspaceIds` — schedulers are started for
 *  every Opened workspace (per the CONTEXT.md definition: a Workspace that
 *  has been activated at least once this session) and stopped when the
 *  workspace closes. */
export function useGitDataSync() {
	const openedWorkspaceIds = usePtyActivityStore((s) => s.openedWorkspaceIds);
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const rightSidebarOpen = useWindowUiStore((s) => s.rightSidebarOpen);
	const activeTab = useWindowUiStore((s) => s.rightSidebarActiveTab);
	const panelOpen = rightSidebarOpen && activeTab === "git";
	const ghStatus = usePrStore((s) => s.ghStatus);

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

	const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
	const activeCwd = activeWorkspace?.rootFolder ?? null;
	const activeBaseBranch = activeWorkspace?.baseBranch ?? null;

	// Workspace-switch effect — hydrate the singleton from cache.
	// Falls back to a one-shot `fetchChanges` only when no cache exists yet
	// (truly cold start: scheduler was just started and hasn't pushed yet, or
	// the scheduler crashed and never pushed). Per-Q4 of the plan: this is
	// the cache-presence gate that replaces the prior 30 s freshness window.
	useEffect(() => {
		useGitChangesStore.getState().hydrateFromWorkspace(activeWorkspaceId);
		usePrStore.getState().hydrateFromWorkspace(activeWorkspaceId);
		if (!activeCwd) return;
		const cwd = activeCwd;
		const baseBranch = activeBaseBranch;
		const wsId = activeWorkspaceId;
		const cached = wsId ? hasGitDataCachedFor(wsId) : false;

		let cancelled = false;
		const rafId = requestAnimationFrame(() => {
			if (cancelled) return;
			if (!cached) {
				// Cold-start fallback. Rare in practice — the scheduler will be
				// running (or about to be) for this workspace, and its initial
				// trigger covers the same data within ~500ms. This `fetchChanges`
				// only matters when the scheduler hasn't pushed even once.
				useGitChangesStore.getState().fetchChanges(cwd, baseBranch);
			}
			// PR data is orthogonal to the git scheduler — keep the invoke path.
			usePrStore
				.getState()
				.checkGhStatus(cwd)
				.then(() => {
					if (cancelled) return;
					const { ghStatus: status } = usePrStore.getState();
					if (status?.available && status?.authenticated) {
						usePrStore.getState().fetchReviewPrs(cwd);
						usePrStore.getState().fetchMyPrs(cwd);
					}
				});
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(rafId);
		};
	}, [activeWorkspaceId, activeCwd, activeBaseBranch]);

	// Adaptive gh polling: 60s when panel open, 300s when collapsed.
	useEffect(() => {
		if (!activeCwd || !ghStatus?.available || !ghStatus?.authenticated) return;
		const cwd = activeCwd;
		const ms = panelOpen ? GH_OPEN_MS : GH_COLLAPSED_MS;
		const interval = setInterval(() => {
			usePrStore.getState().fetchReviewPrs(cwd);
			usePrStore.getState().fetchMyPrs(cwd);
		}, ms);
		return () => clearInterval(interval);
	}, [activeCwd, panelOpen, ghStatus?.available, ghStatus?.authenticated]);
}
