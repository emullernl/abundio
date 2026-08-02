// Derived Worktree set grouping for the Left sidebar. Pure and testable — the
// single home for the "set-contiguous + primary-first" render constraints
// (Decision 2 / ADR-0017). Grouping comes from git (never stored): two
// workspaces share a set iff they report the same `worktreeGroupKey`.

import type { WorkspaceWithTabs } from "./types";

/** The grouping facts a workspace contributes, sourced from `workspaceGitStore`. */
export interface WorktreeGroupFacts {
	worktreeGroupKey: string | null;
	isMainWorktree: boolean;
	/** Canonicalized worktree root, for symlink-safe reconcile comparisons. */
	worktreeRoot?: string | null;
}

export interface StandaloneRow {
	kind: "standalone";
	workspace: WorkspaceWithTabs;
}

export interface SetRow {
	kind: "set";
	groupKey: string;
	/** The main worktree — always rendered first. */
	primary: WorkspaceWithTabs;
	/** Non-primary worktrees, ordered by `position` (≈ creation order). */
	linked: WorkspaceWithTabs[];
}

export type WorkspaceRow = StandaloneRow | SetRow;

/** Stable id for a render block — used as a React key and drag handle. */
export function rowId(row: WorkspaceRow): string {
	return row.kind === "set" ? `set:${row.groupKey}` : `ws:${row.workspace.id}`;
}

/** The workspaces a block contains, in render order (primary, then linked). */
export function rowWorkspaces(row: WorkspaceRow): WorkspaceWithTabs[] {
	return row.kind === "set" ? [row.primary, ...row.linked] : [row.workspace];
}

/**
 * Fold an ordered workspace list into render rows. A group of workspaces
 * sharing a `worktreeGroupKey` becomes a Worktree set block **only** when it
 * has ≥2 members and one is a main worktree present in the list; otherwise its
 * members render as ordinary standalone rows (this covers primary-less sets and
 * bare repos — Q11). Set blocks sort among rows by their primary's `position`.
 */
export function buildWorkspaceRows(
	workspaces: WorkspaceWithTabs[],
	facts: Record<string, WorktreeGroupFacts | undefined>,
): WorkspaceRow[] {
	const keyOf = (id: string): string | null =>
		facts[id]?.worktreeGroupKey ?? null;
	const isPrimary = (id: string): boolean => facts[id]?.isMainWorktree ?? false;

	// Bucket workspaces by group key.
	const buckets = new Map<string, WorkspaceWithTabs[]>();
	for (const ws of workspaces) {
		const key = keyOf(ws.id);
		if (!key) continue;
		const arr = buckets.get(key);
		if (arr) arr.push(ws);
		else buckets.set(key, [ws]);
	}

	// A key forms a set only with ≥2 members and a primary present.
	const setKeys = new Set<string>();
	for (const [key, members] of buckets) {
		if (members.length >= 2 && members.some((m) => isPrimary(m.id))) {
			setKeys.add(key);
		}
	}

	const rows: WorkspaceRow[] = [];
	const emitted = new Set<string>();
	for (const ws of workspaces) {
		const key = keyOf(ws.id);
		if (key && setKeys.has(key)) {
			if (emitted.has(key)) continue;
			emitted.add(key);
			const members = buckets.get(key) ?? [ws];
			// `find` is safe: setKeys membership guarantees a primary exists.
			const primary = members.find((m) => isPrimary(m.id)) ?? members[0];
			const linked = members
				.filter((m) => m.id !== primary.id)
				.sort((a, b) => a.position - b.position);
			rows.push({ kind: "set", groupKey: key, primary, linked });
		} else {
			rows.push({ kind: "standalone", workspace: ws });
		}
	}

	// Order blocks by their representative position (primary for a set).
	const sortPos = (row: WorkspaceRow): number =>
		row.kind === "set" ? row.primary.position : row.workspace.position;
	rows.sort((a, b) => sortPos(a) - sortPos(b));
	return rows;
}

/**
 * Flatten render rows back to a workspace-id list in display order (each set as
 * primary-then-linked). Feeding this to `reorderWorkspaces` makes every set's
 * members contiguous in `position`, which is what keeps a dragged set together.
 */
export function flattenRowsToIds(rows: WorkspaceRow[]): string[] {
	return rows.flatMap((row) => rowWorkspaces(row).map((w) => w.id));
}

/**
 * The Workspace a linked worktree inherits Environment Bundles from — its set's
 * main worktree.
 *
 * Returns `null` for a standalone Workspace, for a main worktree itself, and for
 * a primary-less group (which renders as standalone rows anyway). Uses the same
 * grouping rules as `buildWorkspaceRows` so the settings dialog and the PTY
 * spawn path can never disagree about where a variable came from.
 *
 * Deliberately pure and frontend-side: Rust takes the resolved id as a spawn
 * parameter rather than recomputing git grouping on the spawn hot path.
 */
export function inheritSourceWorkspaceId(
	workspaces: WorkspaceWithTabs[],
	facts: Record<string, WorktreeGroupFacts | undefined>,
	workspaceId: string,
): string | null {
	const self = facts[workspaceId];
	if (!self?.worktreeGroupKey) return null;
	// A main worktree is the inheritance source, never a consumer.
	if (self.isMainWorktree) return null;

	const primary = workspaces.find(
		(w) =>
			w.id !== workspaceId &&
			facts[w.id]?.worktreeGroupKey === self.worktreeGroupKey &&
			facts[w.id]?.isMainWorktree,
	);
	return primary?.id ?? null;
}

/** Distinct non-null group keys among the given workspaces (for watch registration). */
export function distinctGroupKeys(
	workspaces: WorkspaceWithTabs[],
	facts: Record<string, WorktreeGroupFacts | undefined>,
): string[] {
	const keys = new Set<string>();
	for (const ws of workspaces) {
		const key = facts[ws.id]?.worktreeGroupKey ?? null;
		if (key) keys.add(key);
	}
	return [...keys];
}
