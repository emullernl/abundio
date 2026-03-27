import { useCallback } from "react";
import { useSessionStore } from "../stores/sessionStore";
import type { PaneNode } from "../lib/types";

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

export function useSplitPane() {
	const { getActiveSession, getActiveLayout, updateLayout, setFocusedPane } =
		useSessionStore();

	const splitPane = useCallback(
		async (paneId: string, direction: "horizontal" | "vertical") => {
			const session = getActiveSession();
			const layout = getActiveLayout();
			if (!session || !layout) return;

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
			await updateLayout(session.id, newLayout);
			setFocusedPane(newTerminal.id);
		},
		[getActiveSession, getActiveLayout, updateLayout, setFocusedPane],
	);

	const closePane = useCallback(
		async (paneId: string) => {
			const session = getActiveSession();
			const layout = getActiveLayout();
			if (!session || !layout) return;

			const newLayout = removeNode(layout, paneId);
			if (newLayout) {
				await updateLayout(session.id, newLayout);
			}
		},
		[getActiveSession, getActiveLayout, updateLayout],
	);

	const updateRatio = useCallback(
		async (splitNodeId: string, ratio: number) => {
			const session = getActiveSession();
			const layout = getActiveLayout();
			if (!session || !layout) return;

			const node = findNode(layout, splitNodeId);
			if (!node || node.type !== "split") return;

			const updated = replaceNode(layout, splitNodeId, { ...node, ratio });
			await updateLayout(session.id, updated);
		},
		[getActiveSession, getActiveLayout, updateLayout],
	);

	return { splitPane, closePane, updateRatio };
}
