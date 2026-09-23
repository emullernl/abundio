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

/** Collect all leaf pane IDs (every non-split node) in tree order (depth-first). */
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

/**
 * A pane that owns no content of its own and is bound to a **source pane** —
 * currently a markdown **preview pane** (ADR-0001). Derived structurally, so a
 * new variant carrying `sourcePaneId` is picked up here automatically.
 */
export type DerivedPaneNode = Extract<PaneNode, { sourcePaneId: string }>;

function isDerived(node: PaneNode): node is DerivedPaneNode {
	return "sourcePaneId" in node;
}

/** Return the derived leaf of the given type bound to `sourcePaneId`, or null. */
export function findDerivedForSource<T extends DerivedPaneNode["type"]>(
	tree: PaneNode,
	sourcePaneId: string,
	type: T,
): Extract<PaneNode, { type: T }> | null {
	if (tree.type === type && isDerived(tree)) {
		return tree.sourcePaneId === sourcePaneId
			? (tree as Extract<PaneNode, { type: T }>)
			: null;
	}
	if (tree.type !== "split") return null;
	return (
		findDerivedForSource(tree.first, sourcePaneId, type) ??
		findDerivedForSource(tree.second, sourcePaneId, type)
	);
}

/** Every derived leaf bound to `sourcePaneId`, whatever its type. */
export function findAllDerivedForSource(
	tree: PaneNode,
	sourcePaneId: string,
): DerivedPaneNode[] {
	const found: DerivedPaneNode[] = [];
	const walk = (node: PaneNode) => {
		if (isDerived(node)) {
			if (node.sourcePaneId === sourcePaneId) found.push(node);
			return;
		}
		if (node.type !== "split") return;
		walk(node.first);
		walk(node.second);
	};
	walk(tree);
	return found;
}

/** Derived leaves whose sourcePaneId does not resolve to a node in the tree. */
export function findOrphanDerived(tree: PaneNode): DerivedPaneNode[] {
	const orphans: DerivedPaneNode[] = [];
	const walk = (node: PaneNode) => {
		if (isDerived(node)) {
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
 * Remove every derived node whose sourcePaneId does not resolve in the tree,
 * collapsing splits as needed. Returns a new tree (or null if it empties out),
 * or the original tree if there were no orphans.
 */
export function pruneOrphanDerived(tree: PaneNode): PaneNode | null {
	const orphans = findOrphanDerived(tree);
	if (orphans.length === 0) return tree;
	let result: PaneNode | null = tree;
	for (const orphan of orphans) {
		if (!result) break;
		result = removeNode(result, orphan.id);
	}
	return result;
}

/** Return the preview leaf bound to the given source pane, or null. */
export function findPreviewForSource(
	tree: PaneNode,
	sourcePaneId: string,
): (PaneNode & { type: "preview" }) | null {
	return findDerivedForSource(tree, sourcePaneId, "preview");
}

/** @deprecated Prefer `findOrphanDerived`, which covers every derived variant. */
export function findOrphanPreviews(
	tree: PaneNode,
): (PaneNode & { type: "preview" })[] {
	return findOrphanDerived(tree).filter(
		(n): n is PaneNode & { type: "preview" } => n.type === "preview",
	);
}

/** @deprecated Prefer `pruneOrphanDerived`, which covers every derived variant. */
export function pruneOrphanPreviews(tree: PaneNode): PaneNode | null {
	return pruneOrphanDerived(tree);
}

/** A leaf Pane's position in its Tab, as fractions of the Tab's area (0–1). */
export interface PaneRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type PaneDirection = "up" | "down" | "left" | "right";

/**
 * Every leaf Pane's rect, derived from the split ratios alone — no DOM, so it is
 * pure and testable. The resizer's few pixels are ignored; they never change
 * which Pane is adjacent to which. A `vertical` split lays its children side by
 * side (see `SplitContainer`), a `horizontal` one stacks them.
 */
export function paneRects(
	tree: PaneNode,
	rect: PaneRect = { x: 0, y: 0, w: 1, h: 1 },
): Map<string, PaneRect> {
	const out = new Map<string, PaneRect>();
	const walk = (node: PaneNode, r: PaneRect) => {
		if (node.type !== "split") {
			out.set(node.id, r);
			return;
		}
		if (node.direction === "vertical") {
			const w1 = r.w * node.ratio;
			walk(node.first, { x: r.x, y: r.y, w: w1, h: r.h });
			walk(node.second, { x: r.x + w1, y: r.y, w: r.w - w1, h: r.h });
		} else {
			const h1 = r.h * node.ratio;
			walk(node.first, { x: r.x, y: r.y, w: r.w, h: h1 });
			walk(node.second, { x: r.x, y: r.y + h1, w: r.w, h: r.h - h1 });
		}
	};
	walk(tree, rect);
	return out;
}

const EDGE_EPSILON = 1e-6;

/**
 * The **Directional move** target: the Pane bordering `fromId` on the given
 * side, or `null` at the Tab's edge (it does not wrap). When several Panes
 * border that side, the winner is the one lying across from `fromId`'s centre
 * line — a rule the layout alone decides, never focus history.
 */
export function neighbourInDirection(
	tree: PaneNode,
	fromId: string,
	direction: PaneDirection,
): string | null {
	const rects = paneRects(tree);
	const from = rects.get(fromId);
	if (!from) return null;

	const horizontal = direction === "left" || direction === "right";
	// The edge of `from` we are crossing, and the centre line along it.
	const edge =
		direction === "right"
			? from.x + from.w
			: direction === "left"
				? from.x
				: direction === "down"
					? from.y + from.h
					: from.y;
	const centre = horizontal ? from.y + from.h / 2 : from.x + from.w / 2;

	let best: string | null = null;
	let bestOverlap = 0;
	for (const [id, r] of rects) {
		if (id === fromId) continue;
		// The candidate's edge that would touch ours.
		const touching =
			direction === "right"
				? r.x
				: direction === "left"
					? r.x + r.w
					: direction === "down"
						? r.y
						: r.y + r.h;
		if (Math.abs(touching - edge) > EDGE_EPSILON) continue;
		const start = horizontal ? r.y : r.x;
		const end = horizontal ? r.y + r.h : r.x + r.w;
		// Across from the centre line: the rule's winner, decided outright.
		if (start <= centre + EDGE_EPSILON && centre < end - EDGE_EPSILON) {
			return id;
		}
		// Otherwise keep the one sharing the most edge, as a float-safety net.
		const fromStart = horizontal ? from.y : from.x;
		const fromEnd = horizontal ? from.y + from.h : from.x + from.w;
		const overlap = Math.min(end, fromEnd) - Math.max(start, fromStart);
		if (overlap > bestOverlap + EDGE_EPSILON) {
			best = id;
			bestOverlap = overlap;
		}
	}
	return best;
}

/**
 * The **Pane cycle** target: the Pane `step` places after `fromId` in
 * depth-first tree order, wrapping at the ends. Visits every Pane type. A
 * `fromId` not in the tree lands on the first Pane. `null` when there is no
 * other Pane to go to.
 */
export function cyclePane(
	tree: PaneNode,
	fromId: string | null,
	step: 1 | -1,
): string | null {
	const ids = collectPaneIds(tree);
	if (ids.length === 0) return null;
	const idx = fromId ? ids.indexOf(fromId) : -1;
	if (idx === -1) return ids[0];
	if (ids.length === 1) return null;
	return ids[(idx + step + ids.length) % ids.length];
}
