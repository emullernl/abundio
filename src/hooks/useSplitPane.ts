import { useCallback } from "react";
import { pty } from "../lib/ipc";
import { suppressMarkdownPreview } from "../lib/markdownPreview";
import {
	collectTerminals,
	findNode,
	findPreviewForSource,
	removeNode,
	replaceNode,
	wrapInSplit,
} from "../lib/paneTree";
import { setPendingAgent } from "../lib/pendingAgentRegistry";
import { destroyTerminal } from "../lib/terminalManager";
import type { CodingAgent, PaneNode } from "../lib/types";
import { useExplorerStore } from "../stores/explorerStore";
import { requestPaneClose } from "../stores/paneCloseConfirmStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

function generateId(): string {
	return crypto.randomUUID();
}

export function useSplitPane() {
	const getActiveTab = useWorkspaceStore((s) => s.getActiveTab);
	const getActiveLayout = useWorkspaceStore((s) => s.getActiveLayout);
	const updateLayout = useWorkspaceStore((s) => s.updateLayout);
	const updateLayoutLocal = useWorkspaceStore((s) => s.updateLayoutLocal);
	const persistLayout = useWorkspaceStore((s) => s.persistLayout);
	const setFocusedPane = useWorkspaceStore((s) => s.setFocusedPane);
	const closeTab = useWorkspaceStore((s) => s.closeTab);

	/** Split with an explicit choice (called by LaunchPicker handler in App.tsx). */
	const splitPaneWithChoice = useCallback(
		async (
			paneId: string,
			direction: "horizontal" | "vertical",
			agent?: CodingAgent,
		) => {
			const tab = getActiveTab();
			const layout = getActiveLayout();
			if (!tab || !layout) return;

			const newPaneId = generateId();
			const newTerminal: PaneNode = {
				type: "terminal",
				id: newPaneId,
				ptyId: "",
				agentId: agent?.id,
			};

			if (!findNode(layout, paneId)) return;

			const newLayout = wrapInSplit(layout, paneId, newTerminal, direction);
			await updateLayout(tab.id, newLayout);
			setFocusedPane(newPaneId);

			if (agent) {
				setPendingAgent(newPaneId, {
					command: [agent.command, ...(agent.args ?? [])].join(" "),
				});
			}
		},
		[getActiveTab, getActiveLayout, updateLayout, setFocusedPane],
	);

	/**
	 * Split with picker (called by keybindings/buttons).
	 * Opens LaunchPicker via a custom event so App.tsx can intercept it.
	 */
	const splitPaneWithPicker = useCallback(
		(paneId: string, direction: "horizontal" | "vertical") => {
			window.dispatchEvent(
				new CustomEvent("abundio:split-with-picker", {
					detail: { paneId, direction },
				}),
			);
		},
		[],
	);

	const closePaneNow = useCallback(
		async (paneId: string) => {
			const tab = getActiveTab();
			const layout = getActiveLayout();
			if (!tab || !layout) return;

			// Destroy terminal instance, kill PTY, and clean up log file
			const node = findNode(layout, paneId);
			// A file pane's bound preview pane is closed alongside it.
			let cascadePreviewId: string | null = null;
			if (node?.type === "terminal") {
				destroyTerminal(paneId);
				if (node.ptyId) {
					pty.kill(node.ptyId).catch(() => {});
				}
				pty.deleteLog(paneId).catch(() => {});
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
			if (newLayout) {
				await updateLayout(tab.id, newLayout);
				// Focus the first terminal or file leaf in the remaining tree
				const terminals = collectTerminals(newLayout);
				if (terminals.length > 0) {
					setFocusedPane(terminals[0].id);
				} else {
					setFocusedPane(null);
				}
			} else {
				// Last pane removed — close the tab itself
				await closeTab(tab.id);
			}
		},
		[getActiveTab, getActiveLayout, updateLayout, setFocusedPane, closeTab],
	);

	const closePane = useCallback((paneId: string, label?: string) => {
		requestPaneClose(paneId, label);
	}, []);

	/** Local-only ratio update (no DB persist) — call during drag. */
	const updateRatioLocal = useCallback(
		(splitNodeId: string, ratio: number) => {
			const tab = getActiveTab();
			const layout = getActiveLayout();
			if (!tab || !layout) return;

			const node = findNode(layout, splitNodeId);
			if (!node || node.type !== "split") return;

			const updated = replaceNode(layout, splitNodeId, { ...node, ratio });
			updateLayoutLocal(tab.id, updated);
		},
		[getActiveTab, getActiveLayout, updateLayoutLocal],
	);

	/** Persist current layout to DB — call on mouseup after drag. */
	const persistCurrentLayout = useCallback(async () => {
		const tab = getActiveTab();
		if (!tab) return;
		await persistLayout(tab.id);
	}, [getActiveTab, persistLayout]);

	/** Navigate focus to adjacent pane in the given direction. */
	const navigatePane = useCallback(
		(direction: "up" | "down" | "left" | "right") => {
			const layout = getActiveLayout();
			if (!layout) return;

			const terminals = collectTerminals(layout);
			if (terminals.length <= 1) return;

			const currentFocused = useWorkspaceStore.getState().focusedPaneId;
			const currentIndex = terminals.findIndex((t) => t.id === currentFocused);
			if (currentIndex === -1) {
				setFocusedPane(terminals[0].id);
				return;
			}

			let nextIndex: number;
			if (direction === "right" || direction === "down") {
				nextIndex = (currentIndex + 1) % terminals.length;
			} else {
				nextIndex = (currentIndex - 1 + terminals.length) % terminals.length;
			}

			setFocusedPane(terminals[nextIndex].id);
		},
		[getActiveLayout, setFocusedPane],
	);

	return {
		splitPaneWithChoice,
		splitPaneWithPicker,
		// Legacy alias used by tests / code that hasn't migrated
		splitPane: splitPaneWithPicker,
		closePane,
		closePaneNow,
		updateRatioLocal,
		persistCurrentLayout,
		navigatePane,
	};
}
