import { useCallback } from "react";
import { pty } from "../lib/ipc";
import {
	collectTerminals,
	findNode,
	removeNode,
	replaceNode,
} from "../lib/paneTree";
import { destroyTerminal } from "../lib/terminalManager";
import type { PaneNode } from "../lib/types";
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
	const setMaximized = useWorkspaceStore((s) => s.setMaximized);

	const splitPane = useCallback(
		async (paneId: string, direction: "horizontal" | "vertical") => {
			const tab = getActiveTab();
			const layout = getActiveLayout();
			if (!tab || !layout) return;

			const newTerminal: PaneNode = {
				type: "terminal",
				id: generateId(),
				ptyId: "",
			};

			const target = findNode(layout, paneId);
			if (!target) return;

			const splitNode: PaneNode = {
				type: "split",
				id: generateId(),
				direction,
				ratio: 0.5,
				first: target,
				second: newTerminal,
			};

			const newLayout = replaceNode(layout, paneId, splitNode);
			await updateLayout(tab.id, newLayout);
			setFocusedPane(newTerminal.id);
		},
		[getActiveTab, getActiveLayout, updateLayout, setFocusedPane],
	);

	const closePane = useCallback(
		async (paneId: string) => {
			const tab = getActiveTab();
			const layout = getActiveLayout();
			if (!tab || !layout) return;

			// Destroy terminal instance, kill PTY, and clean up log file
			const node = findNode(layout, paneId);
			if (node?.type === "terminal") {
				destroyTerminal(paneId);
				if (node.ptyId) {
					pty.kill(node.ptyId).catch(() => {});
				}
				pty.deleteLog(paneId).catch(() => {});
			}

			const newLayout = removeNode(layout, paneId);
			if (newLayout) {
				await updateLayout(tab.id, newLayout);
				// Focus the first terminal in the remaining tree
				const terminals = collectTerminals(newLayout);
				if (terminals.length > 0) {
					setFocusedPane(terminals[0].id);
				}
			}

			// Clear maximize state if the maximized pane was closed
			if (useWorkspaceStore.getState().maximizedPaneId === paneId) {
				setMaximized(null, null);
			}
		},
		[getActiveTab, getActiveLayout, updateLayout, setFocusedPane, setMaximized],
	);

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

	/** Toggle maximize/restore for the focused pane. */
	const toggleMaximize = useCallback(async () => {
		const tab = getActiveTab();
		const layout = getActiveLayout();
		const { focusedPaneId, maximizedPaneId, savedLayout } =
			useWorkspaceStore.getState();
		if (!tab || !layout || !focusedPaneId) return;

		if (maximizedPaneId) {
			// Restore: put back the saved layout
			if (savedLayout) {
				await updateLayout(tab.id, savedLayout);
			}
			setMaximized(null, null);
		} else {
			// Maximize: find the focused terminal and make it the only pane
			const node = findNode(layout, focusedPaneId);
			if (!node || node.type !== "terminal") return;

			setMaximized(focusedPaneId, layout);
			const maximizedLayout: PaneNode = { ...node };
			await updateLayout(tab.id, maximizedLayout);
		}
	}, [getActiveTab, getActiveLayout, updateLayout, setMaximized]);

	return {
		splitPane,
		closePane,
		updateRatioLocal,
		persistCurrentLayout,
		navigatePane,
		toggleMaximize,
	};
}
