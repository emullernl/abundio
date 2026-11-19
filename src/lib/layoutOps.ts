import type { PaneNode } from "./types";

/**
 * A Tab's layout edit as Rust takes it (ADR-0063, docs/plans/remote-hosts.md
 * phase 4). The Window still computes each new layout with `paneTree.ts`;
 * `diffLayout` turns old → new into the smallest set of node-level ops, and
 * Rust (`layout_ops.rs`) applies them to its own copy. Nodes are named by id,
 * not by position, so two Clients editing different panes both land.
 *
 * - `set`: the whole tree (its root changed).
 * - `replace`: the subtree whose root is `id`.
 * - `patch`: the node `id`'s own fields (never a split's children).
 */
export type LayoutOp =
	| { op: "set"; layout: PaneNode }
	| { op: "replace"; id: string; node: PaneNode }
	| {
			op: "patch";
			id: string;
			set: Record<string, unknown>;
			unset: string[];
	  };

type Json = Record<string, unknown>;

const CHILDREN = new Set(["first", "second"]);

/** Deep equality of JSON values, whatever the order of their keys (Rust's
 *  answers come through a JSON value whose keys are sorted). */
export function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null
	) {
		return false;
	}
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
	}
	const ak = Object.keys(a as Json);
	const bk = Object.keys(b as Json);
	if (ak.length !== bk.length) return false;
	return ak.every(
		(k) => k in (b as Json) && sameJson((a as Json)[k], (b as Json)[k]),
	);
}

/** Whether two layouts are the same tree (key order ignored). */
export function sameLayout(a: PaneNode | null, b: PaneNode | null): boolean {
	return sameJson(a, b);
}

function diffNode(a: Json, b: Json, ops: LayoutOp[]): void {
	const id = a.id as string;
	if (a.type !== b.type) {
		ops.push({ op: "replace", id, node: b as unknown as PaneNode });
		return;
	}
	const set: Record<string, unknown> = {};
	const unset: string[] = [];
	for (const k of Object.keys(b)) {
		if (CHILDREN.has(k) && b.type === "split") continue;
		if (!sameJson(a[k], b[k])) set[k] = b[k];
	}
	for (const k of Object.keys(a)) {
		if (CHILDREN.has(k) && a.type === "split") continue;
		if (!(k in b)) unset.push(k);
	}
	if (Object.keys(set).length > 0 || unset.length > 0) {
		ops.push({ op: "patch", id, set, unset });
	}
	if (b.type !== "split") return;
	for (const side of ["first", "second"] as const) {
		const ac = a[side] as Json;
		const bc = b[side] as Json;
		if (ac.id !== bc.id) {
			ops.push({
				op: "replace",
				id: ac.id as string,
				node: bc as unknown as PaneNode,
			});
		} else {
			diffNode(ac, bc, ops);
		}
	}
}

/**
 * The ops that turn `base` into `next`. Both must be plain JSON (as parsed
 * from a layoutJson): an `undefined` field would read as a change.
 */
export function diffLayout(base: PaneNode, next: PaneNode): LayoutOp[] {
	const a = base as unknown as Json;
	const b = next as unknown as Json;
	if (a.id !== b.id) return [{ op: "set", layout: next }];
	const ops: LayoutOp[] = [];
	diffNode(a, b, ops);
	return ops;
}

function clone<T>(v: T): T {
	return JSON.parse(JSON.stringify(v)) as T;
}

/** The first node with `id`, depth first (`first` before `second`), as
 *  `findNode` does; `parent`/`side` name where it hangs (none for the root). */
function locate(
	tree: Json,
	id: string,
): { node: Json; parent: Json | null; side: "first" | "second" | null } | null {
	if (tree.id === id) return { node: tree, parent: null, side: null };
	if (tree.type !== "split") return null;
	for (const side of ["first", "second"] as const) {
		const child = tree[side] as Json;
		if (child.id === id) return { node: child, parent: tree, side };
		const deeper = locate(child, id);
		if (deeper) return deeper;
	}
	return null;
}

/**
 * Apply `ops` to `tree`, as Rust does. Returns null when an op names a node
 * that is not there (another Client removed it): Rust then applies nothing
 * and answers with its layout as it stands.
 */
export function applyLayoutOps(
	tree: PaneNode,
	ops: readonly LayoutOp[],
): PaneNode | null {
	let root = clone(tree) as unknown as Json;
	for (const op of ops) {
		if (op.op === "set") {
			root = clone(op.layout) as unknown as Json;
			continue;
		}
		const at = locate(root, op.id);
		if (!at) return null;
		if (op.op === "replace") {
			const node = clone(op.node) as unknown as Json;
			if (at.parent && at.side) at.parent[at.side] = node;
			else root = node;
		} else {
			for (const k of op.unset) delete at.node[k];
			for (const [k, v] of Object.entries(op.set)) at.node[k] = clone(v);
		}
	}
	return root as unknown as PaneNode;
}
