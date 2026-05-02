import type { PaneNode } from "./types";

export function findNode(tree: PaneNode, id: string): PaneNode | null {
	if (tree.id === id) return tree;
	if (tree.type === "split") {
		return findNode(tree.first, id) || findNode(tree.second, id);
	}
	return null;
}

export function replaceNode(
	tree: PaneNode,
	id: string,
	replacement: PaneNode,
): PaneNode {
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

export function removeNode(tree: PaneNode, id: string): PaneNode | null {
	if (tree.type !== "split") {
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
export function collectTerminals(
	tree: PaneNode,
): { id: string; ptyId: string }[] {
	if (tree.type === "terminal") return [{ id: tree.id, ptyId: tree.ptyId }];
	if (tree.type === "file") return [];
	return [...collectTerminals(tree.first), ...collectTerminals(tree.second)];
}

/**
 * Set the agentId on the terminal node with the given paneId.
 * Pass `undefined` to clear it. Returns a new tree with structural sharing.
 */
export function setAgentId(
	tree: PaneNode,
	paneId: string,
	agentId: string | undefined,
): PaneNode {
	if (tree.type === "terminal") {
		if (tree.id !== paneId) return tree;
		if (agentId === undefined) {
			const { agentId: _drop, ...rest } = tree;
			return rest;
		}
		return { ...tree, agentId };
	}
	if (tree.type === "file") return tree;
	const first = setAgentId(tree.first, paneId, agentId);
	const second = setAgentId(tree.second, paneId, agentId);
	if (first === tree.first && second === tree.second) return tree;
	return { ...tree, first, second };
}

/** Collect all terminal nodes that have a non-empty agentId. */
export function collectAgentPanes(
	tree: PaneNode,
): { paneId: string; agentId: string }[] {
	if (tree.type === "terminal") {
		return tree.agentId ? [{ paneId: tree.id, agentId: tree.agentId }] : [];
	}
	if (tree.type === "file") return [];
	return [...collectAgentPanes(tree.first), ...collectAgentPanes(tree.second)];
}

/** Collect all leaf pane IDs (terminal + file) in tree order (depth-first). */
export function collectPaneIds(tree: PaneNode): string[] {
	if (tree.type === "terminal" || tree.type === "file") return [tree.id];
	return [...collectPaneIds(tree.first), ...collectPaneIds(tree.second)];
}

/** Collect only terminal pane IDs (depth-first). */
export function collectTerminalIds(tree: PaneNode): string[] {
	if (tree.type === "terminal") return [tree.id];
	if (tree.type === "file") return [];
	return [
		...collectTerminalIds(tree.first),
		...collectTerminalIds(tree.second),
	];
}

/** Return the first file leaf in the tree, or null. */
export function findFilePaneInTree(
	tree: PaneNode,
): (PaneNode & { type: "file" }) | null {
	if (tree.type === "file") return tree;
	if (tree.type === "terminal") return null;
	return findFilePaneInTree(tree.first) ?? findFilePaneInTree(tree.second);
}

/** Return the first file leaf with the given filePath, or null. */
export function findFilePaneByPath(
	tree: PaneNode,
	filePath: string,
): (PaneNode & { type: "file" }) | null {
	if (tree.type === "file") return tree.filePath === filePath ? tree : null;
	if (tree.type === "terminal") return null;
	return (
		findFilePaneByPath(tree.first, filePath) ??
		findFilePaneByPath(tree.second, filePath)
	);
}
