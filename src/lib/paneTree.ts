import type { PaneNode } from "./types";

/** Parse a Tab's stored layoutJson. Returns null on malformed JSON rather than throwing. */
export function parseTabLayout(layoutJson: string): PaneNode | null {
	try {
		return JSON.parse(layoutJson) as PaneNode;
	} catch {
		return null;
	}
}

export function findNode(tree: PaneNode, id: string): PaneNode | null {
	if (tree.id === id) return tree;
	if (tree.type === "split") {
		return findNode(tree.first, id) || findNode(tree.second, id);
	}
	return null;
}

export function containsPane(tree: PaneNode, id: string): boolean {
	return findNode(tree, id) !== null;
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
): { id: string; ptyId: string; cwd?: string }[] {
	if (tree.type === "terminal")
		return [{ id: tree.id, ptyId: tree.ptyId, cwd: tree.cwd }];
	if (tree.type !== "split") return [];
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
			if (tree.agentId === undefined) return tree;
			const { agentId: _drop, ...rest } = tree;
			return rest;
		}
		if (tree.agentId === agentId) return tree;
		return { ...tree, agentId };
	}
	if (tree.type !== "split") return tree;
	const first = setAgentId(tree.first, paneId, agentId);
	const second = setAgentId(tree.second, paneId, agentId);
	if (first === tree.first && second === tree.second) return tree;
	return { ...tree, first, second };
}

/**
 * Set the cwd on the terminal node with the given paneId.
 * Pass `undefined` or empty string to clear it. Returns a new tree with structural sharing.
 */
export function setCwd(
	tree: PaneNode,
	paneId: string,
	cwd: string | undefined,
): PaneNode {
	if (tree.type === "terminal") {
		if (tree.id !== paneId) return tree;
		if (!cwd) {
			const { cwd: _drop, ...rest } = tree;
			return rest;
		}
		if (tree.cwd === cwd) return tree;
		return { ...tree, cwd };
	}
	if (tree.type !== "split") return tree;
	const first = setCwd(tree.first, paneId, cwd);
	const second = setCwd(tree.second, paneId, cwd);
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
	if (tree.type !== "split") return [];
	return [...collectAgentPanes(tree.first), ...collectAgentPanes(tree.second)];
}

/** Collect all leaf pane IDs (terminal + file + preview) in tree order (depth-first). */
export function collectPaneIds(tree: PaneNode): string[] {
	if (tree.type !== "split") return [tree.id];
	return [...collectPaneIds(tree.first), ...collectPaneIds(tree.second)];
}

/** Collect only terminal pane IDs (depth-first). */
export function collectTerminalIds(tree: PaneNode): string[] {
	if (tree.type === "terminal") return [tree.id];
	if (tree.type !== "split") return [];
	return [
		...collectTerminalIds(tree.first),
		...collectTerminalIds(tree.second),
	];
}

/** Collect only file pane IDs (depth-first). */
export function collectFilePaneIds(tree: PaneNode): string[] {
	if (tree.type === "file") return [tree.id];
	if (tree.type !== "split") return [];
	return [
		...collectFilePaneIds(tree.first),
		...collectFilePaneIds(tree.second),
	];
}

/** Return the first file leaf in the tree, or null. */
export function findFilePaneInTree(
	tree: PaneNode,
): (PaneNode & { type: "file" }) | null {
	if (tree.type === "file") return tree;
	if (tree.type !== "split") return null;
	return findFilePaneInTree(tree.first) ?? findFilePaneInTree(tree.second);
}

/**
 * Wrap the target node in a new split, placing `newLeaf` as the second child.
 * Returns a new tree. If `targetPaneId` is not found, returns the original tree.
 */
export function wrapInSplit(
	tree: PaneNode,
	targetPaneId: string,
	newLeaf: PaneNode,
	direction: "horizontal" | "vertical",
): PaneNode {
	const target = findNode(tree, targetPaneId);
	if (!target) return tree;
	const splitNode: PaneNode = {
		type: "split",
		id: crypto.randomUUID(),
		direction,
		ratio: 0.5,
		first: target,
		second: newLeaf,
	};
	return replaceNode(tree, targetPaneId, splitNode);
}

/**
 * Extract a node from the tree by id. Returns the removed node and the
 * remaining tree. If id is not found, remaining is the original tree and
 * removed is null. If the tree becomes empty, remaining is null.
 */
export function extractNode(
	tree: PaneNode,
	id: string,
): { remaining: PaneNode | null; removed: PaneNode | null } {
	const removed = findNode(tree, id);
	if (!removed) return { remaining: tree, removed: null };
	const remaining = removeNode(tree, id);
	return { remaining, removed };
}

/**
 * Insert newNode beside the target pane, creating a split at the given edge.
 * top/bottom → horizontal split; left/right → vertical split.
 * "top" and "left" place the new node first (above/left of target).
 */
export function insertBesideNode(
	tree: PaneNode,
	targetPaneId: string,
	newNode: PaneNode,
	edge: "top" | "right" | "bottom" | "left",
): PaneNode {
	const target = findNode(tree, targetPaneId);
	if (!target) return tree;
	const direction =
		edge === "top" || edge === "bottom" ? "horizontal" : "vertical";
	const first = edge === "top" || edge === "left" ? newNode : target;
	const second = edge === "top" || edge === "left" ? target : newNode;
	const splitNode: PaneNode = {
		type: "split",
		id: crypto.randomUUID(),
		direction,
		ratio: 0.5,
		first,
		second,
	};
	return replaceNode(tree, targetPaneId, splitNode);
}

/** Return the first file leaf with the given filePath, or null. */
export function findFilePaneByPath(
	tree: PaneNode,
	filePath: string,
): (PaneNode & { type: "file" }) | null {
	if (tree.type === "file") return tree.filePath === filePath ? tree : null;
	if (tree.type !== "split") return null;
	return (
		findFilePaneByPath(tree.first, filePath) ??
		findFilePaneByPath(tree.second, filePath)
	);
}

/** Return the preview leaf bound to the given source pane, or null. */
export function findPreviewForSource(
	tree: PaneNode,
	sourcePaneId: string,
): (PaneNode & { type: "preview" }) | null {
	if (tree.type === "preview")
		return tree.sourcePaneId === sourcePaneId ? tree : null;
	if (tree.type !== "split") return null;
	return (
		findPreviewForSource(tree.first, sourcePaneId) ??
		findPreviewForSource(tree.second, sourcePaneId)
	);
}

/** Collect preview leaves whose sourcePaneId does not resolve to a node in the tree. */
export function findOrphanPreviews(
	tree: PaneNode,
): (PaneNode & { type: "preview" })[] {
	const orphans: (PaneNode & { type: "preview" })[] = [];
	const walk = (node: PaneNode) => {
		if (node.type === "preview") {
			if (!findNode(tree, node.sourcePaneId)) orphans.push(node);
			return;
		}
		if (node.type !== "split") return;
		walk(node.first);
		walk(node.second);
	};
	walk(tree);
	return orphans;
}

/**
 * Remove every preview node whose sourcePaneId does not resolve in the tree,
 * collapsing splits as needed. Returns a new tree (or null if it empties out),
 * or the original tree if there were no orphans.
 */
export function pruneOrphanPreviews(tree: PaneNode): PaneNode | null {
	const orphans = findOrphanPreviews(tree);
	if (orphans.length === 0) return tree;
	let result: PaneNode | null = tree;
	for (const orphan of orphans) {
		if (!result) break;
		result = removeNode(result, orphan.id);
	}
	return result;
}
