import { useCallback } from "react";
import { useSessionStore } from "../stores/sessionStore";
import type { PaneNode } from "../lib/types";
import { pty } from "../lib/ipc";
import { destroyTerminal } from "../lib/terminalManager";

function generateId(): string {
	return crypto.randomUUID();
}

function findNode(tree: PaneNode, id: string): PaneNode | null {
	if (tree.id === id) return tree;
	if (tree.type === "split") {
		return findNode(tree.first, id) || findNode(tree.second, id);
	}
	return null;
}

function replaceNode(tree: PaneNode, id: string, replacement: PaneNode): PaneNode {
	if (tree.id === id) return replacement;
	if (tree.type === "split") {
		return {
			...tree,
			first: replaceNode(tree.first, id, replacement),
			second: replaceNode(tree.second, id, replacement),
		};
	}
	return tree;
}

function removeNode(tree: PaneNode, id: string): PaneNode | null {
	if (tree.type === "terminal") {
		return tree.id === id ? null : tree;
	}
	if (tree.first.id === id) return tree.second;
	if (tree.second.id === id) return tree.first;

	const newFirst = removeNode(tree.first, id);
	if (newFirst !== tree.first) {
		return newFirst ? { ...tree, first: newFirst } : tree.second;
	}

	const newSecond = removeNode(tree.second, id);
	if (newSecond !== tree.second) {
		return newSecond ? { ...tree, second: newSecond } : tree.first;
	}

	return tree;
}

/** Collect all terminal node IDs in tree order (depth-first). */
function collectTerminals(tree: PaneNode): { id: string; ptyId: string }[] {
	if (tree.type === "terminal") return [{ id: tree.id, ptyId: tree.ptyId }];
	return [...collectTerminals(tree.first), ...collectTerminals(tree.second)];
}

export function useSplitPane() {
	const {
		getActiveTab,
		getActiveLayout,
		updateLayout,
		updateLayoutLocal,
		persistLayout,
		setFocusedPane,
		focusedPaneId,
		maximizedPaneId,
		savedLayout,
		setMaximized,
	} = useSessionStore();

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
			if (maximizedPaneId === paneId) {
				setMaximized(null, null);
			}
		},
		[getActiveTab, getActiveLayout, updateLayout, setFocusedPane, maximizedPaneId, setMaximized],
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

			const currentIndex = terminals.findIndex((t) => t.id === focusedPaneId);
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
		[getActiveLayout, focusedPaneId, setFocusedPane],
	);

	/** Toggle maximize/restore for the focused pane. */
	const toggleMaximize = useCallback(async () => {
		const tab = getActiveTab();
		const layout = getActiveLayout();
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
	}, [getActiveTab, getActiveLayout, focusedPaneId, maximizedPaneId, savedLayout, updateLayout, setMaximized]);

	return {
		splitPane,
		closePane,
		updateRatioLocal,
		persistCurrentLayout,
		navigatePane,
		toggleMaximize,
	};
}
