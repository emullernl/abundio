import { useCallback } from "react";
import { useSessionStore } from "../stores/sessionStore";
import type { PaneNode } from "../lib/types";
import { pty } from "../lib/ipc";
import { destroyTerminal } from "../lib/terminalManager";
import { findNode, replaceNode, removeNode, collectTerminals } from "../lib/paneTree";

function generateId(): string {
	return crypto.randomUUID();
}

export function useSplitPane() {
	const getActiveTab = useSessionStore((s) => s.getActiveTab);
	const getActiveLayout = useSessionStore((s) => s.getActiveLayout);
	const updateLayout = useSessionStore((s) => s.updateLayout);
	const updateLayoutLocal = useSessionStore((s) => s.updateLayoutLocal);
	const persistLayout = useSessionStore((s) => s.persistLayout);
	const setFocusedPane = useSessionStore((s) => s.setFocusedPane);
	const setMaximized = useSessionStore((s) => s.setMaximized);

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
			if (useSessionStore.getState().maximizedPaneId === paneId) {
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

			const currentFocused = useSessionStore.getState().focusedPaneId;
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
		const { focusedPaneId, maximizedPaneId, savedLayout } = useSessionStore.getState();
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
