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
export function collectTerminals(
	tree: PaneNode,
): { id: string; ptyId: string }[] {
	if (tree.type === "terminal") return [{ id: tree.id, ptyId: tree.ptyId }];
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
	return [...collectAgentPanes(tree.first), ...collectAgentPanes(tree.second)];
}

/** Collect just the terminal pane IDs in tree order (depth-first). */
export function collectPaneIds(tree: PaneNode): string[] {
	if (tree.type === "terminal") return [tree.id];
	return [...collectPaneIds(tree.first), ...collectPaneIds(tree.second)];
}
