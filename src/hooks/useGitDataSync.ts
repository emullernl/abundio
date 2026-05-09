import { useEffect, useRef } from "react";
import { fs } from "../lib/ipc";
import { useGitChangesStore } from "../stores/gitChangesStore";
import { usePrStore } from "../stores/prStore";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useWorkspaceGitStore } from "../stores/workspaceGitStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

const MIN_INTERVAL = 500;
const GH_OPEN_MS = 60_000;
const GH_COLLAPSED_MS = 60_000;

interface ActiveWatcher {
	workspaceId: string;
	unlistenFs: (() => void) | null;
	unlistenGit: (() => void) | null;
	cancelled: boolean;
	fsTrailingTimer: ReturnType<typeof setTimeout> | null;
	gitTrailingTimer: ReturnType<typeof setTimeout> | null;
	lastFsAt: number;
	lastGitAt: number;
}

function teardown(entry: ActiveWatcher) {
	entry.cancelled = true;
	entry.unlistenFs?.();
	entry.unlistenGit?.();
	if (entry.fsTrailingTimer) clearTimeout(entry.fsTrailingTimer);
	if (entry.gitTrailingTimer) clearTimeout(entry.gitTrailingTimer);
}

export function useGitDataSync() {
	const openedWorkspaceIds = usePtyActivityStore((s) => s.openedWorkspaceIds);
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const panelOpen = useGitChangesStore((s) => s.panelOpen);
	const ghStatus = usePrStore((s) => s.ghStatus);

	const activeRef = useRef<Map<string, ActiveWatcher>>(new Map());

	// Per-opened-workspace fs/git event subscriptions. Lifecycle mirrors
	// useFileReloadWatcher: Map<workspaceId, ActiveWatcher> ref + set diff.
	// Callbacks read activeWorkspaceId fresh so routing (active vs background)
	// stays correct across workspace switches without restarting listeners.
	useEffect(() => {
		const active = activeRef.current;

		const desiredIds = new Set<string>();
		for (const wsId of openedWorkspaceIds) {
			const ws = workspaces.find((w) => w.id === wsId);
			if (ws?.rootFolder) desiredIds.add(wsId);
		}

		for (const [wsId, entry] of active) {
			if (!desiredIds.has(wsId)) {
				teardown(entry);
				active.delete(wsId);
			}
		}

		for (const wsId of desiredIds) {
			if (active.has(wsId)) continue;
			const ws = workspaces.find((w) => w.id === wsId);
			if (!ws?.rootFolder) continue;
			const cwd = ws.rootFolder;

			const entry: ActiveWatcher = {
				workspaceId: wsId,
				unlistenFs: null,
				unlistenGit: null,
				cancelled: false,
				fsTrailingTimer: null,
				gitTrailingTimer: null,
				lastFsAt: 0,
				lastGitAt: 0,
			};
			active.set(wsId, entry);

			const fireFsRefresh = () => {
				const store = useWorkspaceStore.getState();
				const workspace = store.workspaces.find((w) => w.id === wsId);
				if (!workspace?.rootFolder) return;
				if (store.activeWorkspaceId === wsId) {
					useGitChangesStore
						.getState()
						.fetchChanges(workspace.rootFolder, workspace.baseBranch ?? null);
				} else {
					useWorkspaceGitStore
						.getState()
						.refreshWorkspace(wsId, workspace.rootFolder, workspace.baseBranch ?? null);
				}
			};

			const fireGitFetch = () => {
				const store = useWorkspaceStore.getState();
				const workspace = store.workspaces.find((w) => w.id === wsId);
				if (!workspace?.rootFolder) return;
				if (store.activeWorkspaceId === wsId) {
					useGitChangesStore
						.getState()
						.fetchChanges(workspace.rootFolder, workspace.baseBranch ?? null);
				} else {
					useWorkspaceGitStore
						.getState()
						.fetch(wsId, workspace.rootFolder, workspace.baseBranch ?? null);
				}
			};

			const throttledFsRefresh = () => {
				const now = Date.now();
				const elapsed = now - entry.lastFsAt;
				if (elapsed >= MIN_INTERVAL) {
					entry.lastFsAt = now;
					fireFsRefresh();
				} else if (!entry.fsTrailingTimer) {
					entry.fsTrailingTimer = setTimeout(() => {
						entry.fsTrailingTimer = null;
						entry.lastFsAt = Date.now();
						fireFsRefresh();
					}, MIN_INTERVAL - elapsed);
				}
			};

			const throttledGitFetch = () => {
				const now = Date.now();
				const elapsed = now - entry.lastGitAt;
				if (elapsed >= MIN_INTERVAL) {
					entry.lastGitAt = now;
					fireGitFetch();
				} else if (!entry.gitTrailingTimer) {
					entry.gitTrailingTimer = setTimeout(() => {
						entry.gitTrailingTimer = null;
						entry.lastGitAt = Date.now();
						fireGitFetch();
					}, MIN_INTERVAL - elapsed);
				}
			};

			Promise.all([
				fs.onFsChange(cwd, throttledFsRefresh),
				fs.onGitChange(cwd, throttledGitFetch),
			]).then(([unlistenFsResult, unlistenGitResult]) => {
				if (entry.cancelled) {
					unlistenFsResult();
					unlistenGitResult();
				} else {
					entry.unlistenFs = unlistenFsResult;
					entry.unlistenGit = unlistenGitResult;
				}
			});
		}
	}, [openedWorkspaceIds, workspaces]);

	useEffect(() => {
		const active = activeRef.current;
		return () => {
			for (const entry of active.values()) {
				teardown(entry);
			}
			active.clear();
		};
	}, []);

	const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
	const activeCwd = activeWorkspace?.rootFolder ?? null;
	const activeBaseBranch = activeWorkspace?.baseBranch ?? null;

	// Clear singletons and kick off initial fetches on workspace switch.
	useEffect(() => {
		useGitChangesStore.getState().clear();
		usePrStore.getState().clear();
		if (!activeCwd) return;
		const cwd = activeCwd;
		const baseBranch = activeBaseBranch;
		useGitChangesStore.getState().fetchChanges(cwd, baseBranch);
		usePrStore.getState().checkGhStatus(cwd).then(() => {
			const { ghStatus: status } = usePrStore.getState();
			if (status?.available && status?.authenticated) {
				usePrStore.getState().fetchReviewPrs(cwd);
				usePrStore.getState().fetchMyPrs(cwd);
			}
		});
	}, [activeWorkspaceId, activeCwd, activeBaseBranch]);

	// Fetch when the panel opens so the panel always shows current data even if
	// an event-driven refresh was missed while it was collapsed.
	useEffect(() => {
		if (!panelOpen || !activeCwd) return;
		useGitChangesStore.getState().fetchChanges(activeCwd, activeBaseBranch);
	}, [panelOpen, activeCwd, activeBaseBranch]);

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
	}, [activeCwd, activeWorkspaceId, panelOpen, ghStatus?.available, ghStatus?.authenticated]);
}
