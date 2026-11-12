import { useExplorerStore } from "../stores/explorerStore";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { agentControl } from "./ipc";
import { suppressMarkdownPreview } from "./markdownPreview";
import {
	clearSpawnedBy,
	collectTerminals,
	containsPane,
	findNode,
	findPreviewForSource,
	parseTabLayout,
	removeNode,
} from "./paneTree";
import { teardownTerminal } from "./terminalManager";
import type { PaneNode, Tab } from "./types";

/** The Tab holding `paneId`, in any Workspace, with its parsed layout. */
export function locatePane(
	paneId: string,
): { tab: Tab; layout: PaneNode } | null {
	for (const ws of useWorkspaceStore.getState().workspaces) {
		for (const tab of ws.tabs) {
			const layout = parseTabLayout(tab.layoutJson);
			if (layout && containsPane(layout, paneId)) return { tab, layout };
		}
	}
	return null;
}

/**
 * When a pane closes, its **Spawned panes** and **Spawned tabs** become
 * ordinary ones, in every Workspace Opened in this Window. Since ADR-0055
 * they may sit in another Workspace than their owner. Only Opened ones are
 * edited: this Window's copy of a Workspace another Window has open is
 * stale, and writing it back would undo that Window's changes. Every Window
 * runs this when it hears the pane closed. An owner id left in a Workspace
 * open nowhere is inert, since pane ids are never reused.
 */
export async function releaseOwner(ownerPaneId: string): Promise<void> {
	const opened = usePtyActivityStore.getState().openedWorkspaceIds;
	const store = useWorkspaceStore.getState();
	for (const ws of store.workspaces) {
		if (!opened.has(ws.id)) continue;
		for (const tab of ws.tabs) {
			const layout = parseTabLayout(tab.layoutJson);
			if (!layout) continue;
			const cleared = clearSpawnedBy(layout, ownerPaneId);
			if (cleared !== layout) await store.updateLayout(tab.id, cleared);
		}
	}
	// Only the Tab row's owner column: safe for any Window to write.
	await useWorkspaceStore.getState().releaseSpawnedTabs(ownerPaneId);
}

async function releaseSpawned(ownerPaneId: string) {
	await releaseOwner(ownerPaneId);
	await agentControl.paneClosed(ownerPaneId).catch(() => {});
}

/**
 * Close a pane now, with no confirmation: tear its terminal down, remove it
 * from its Tab (closing the Tab if it was the last pane) and, if it was in
 * the Tab on screen, focus another. The confirmed close and Agent control's
 * `pane close` both end here.
 */
export async function closePaneNow(
	paneId: string,
	opts: { keepFocus?: boolean } = {},
): Promise<void> {
	// Found by id rather than taken from the active Tab: a Fleet tile can
	// close a pane in any Opened workspace (ADR-0040).
	const loc = locatePane(paneId);
	if (!loc) return;
	const { tab, layout } = loc;
	const store = useWorkspaceStore.getState();
	// Focus moves only when the pane was in the Tab on screen in the
	// Workspace view; closing elsewhere must not rearrange that view.
	const inActiveTab = store.getActiveTab()?.id === tab.id;

	// Destroy terminal instance, kill PTY, and clean up log file
	const node = findNode(layout, paneId);
	// A file pane's bound preview pane is closed alongside it.
	let cascadePreviewId: string | null = null;
	if (node?.type === "terminal") {
		// Permanently tear down: stops the background tracker, kills the
		// PTY, and purges activity entries so the Overview bar counts drop
		// (ADR-0020). If this is the last pane, the closeTab cascade below
		// re-runs teardownTerminal over the still-stale stored layout — an
		// intentional, idempotent no-op.
		teardownTerminal(paneId);
	} else if (node?.type === "file") {
		useExplorerStore.getState().unregisterFilePane(paneId);
		cascadePreviewId = findPreviewForSource(layout, paneId)?.id ?? null;
	} else if (node?.type === "preview") {
		// Manually closing a preview suppresses auto-open for its source
		// pane until the user reopens it.
		suppressMarkdownPreview(node.sourcePaneId);
	}

	let newLayout = removeNode(layout, paneId);
	if (newLayout && cascadePreviewId) {
		newLayout = removeNode(newLayout, cascadePreviewId);
	}
	// Forget this pane as its Tab's remembered focus, so switching back
	// to a Tab it was closed in from a Fleet tile does not restore it.
	const remembered = useWorkspaceStore.getState().focusedPaneByTab;
	if (remembered[tab.id] === paneId) {
		const { [tab.id]: _gone, ...rest } = remembered;
		useWorkspaceStore.setState({ focusedPaneByTab: rest });
	}
	if (newLayout) {
		await store.updateLayout(tab.id, newLayout);
	} else {
		// Last pane removed — close the tab itself
		await store.closeTab(tab.id);
	}
	if (node?.type === "terminal") await releaseSpawned(paneId);
	if (!newLayout || !inActiveTab) return;
	// `keepFocus` (Agent control): leave focus where it is when it is on
	// another pane still open, so an Agent closing a pane it spawned does not
	// pull focus from wherever the user is. Otherwise focus the first terminal.
	const focused = useWorkspaceStore.getState().focusedPaneId;
	if (
		opts.keepFocus &&
		focused &&
		focused !== paneId &&
		containsPane(newLayout, focused)
	) {
		return;
	}
	const terminals = collectTerminals(newLayout);
	useWorkspaceStore
		.getState()
		.setFocusedPane(terminals.length > 0 ? terminals[0].id : null);
}
