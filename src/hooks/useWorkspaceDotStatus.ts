import { useMemo } from "react";
import { parseTabLayout } from "../lib/paneTree";
import type { PaneNode, WorkspaceWithTabs } from "../lib/types";
import {
	computeWorkspaceDotStatus,
	type DotStatus,
	dotStatusLabel,
	rollupDotStatus,
	usePtyActivityStore,
} from "../stores/ptyActivityStore";

/** A workspace's parsed tab layouts — the shape every dot-status computation
 *  takes. Shared by the per-workspace hook and the Hidden rollup hooks. */
function tabLayoutsOf(tabs: WorkspaceWithTabs["tabs"]): PaneNode[] {
	const layouts: PaneNode[] = [];
	for (const tab of tabs) {
		const layout = parseTabLayout(tab.layoutJson);
		if (layout) layouts.push(layout);
	}
	return layouts;
}

export function useWorkspaceDotStatus(workspace: WorkspaceWithTabs): DotStatus {
	const tabLayouts = useMemo(
		() => tabLayoutsOf(workspace.tabs),
		[workspace.tabs],
	);

	return usePtyActivityStore((s) =>
		computeWorkspaceDotStatus(
			workspace.id,
			tabLayouts,
			s.activities,
			s.openedWorkspaceIds,
			s.panePtyMap,
		),
	);
}

/**
 * The **Hidden rollup** for a Folded set: one status covering the Linked
 * worktrees whose rows are hidden, at the highest precedence among them.
 *
 * Hoisted here rather than read inside each row because the rows in question
 * are unmounted — folding must not take the sidebar's agent signal with it.
 * Returns a primitive so the store subscription stays referentially stable.
 */
export function useHiddenRollupStatus(
	hidden: WorkspaceWithTabs[],
): DotStatus | null {
	const members = useMemo(
		() =>
			hidden.map((ws) => ({
				id: ws.id,
				layouts: tabLayoutsOf(ws.tabs),
			})),
		[hidden],
	);

	return usePtyActivityStore((s) => {
		if (members.length === 0) return null;
		return rollupDotStatus(
			members.map((m) =>
				computeWorkspaceDotStatus(
					m.id,
					m.layouts,
					s.activities,
					s.openedWorkspaceIds,
					s.panePtyMap,
				),
			),
		);
	});
}

/**
 * Tooltip text for the Hidden rollup — one `name — Status` line per hidden
 * worktree, in render order. A separate subscription from
 * `useHiddenRollupStatus` so both selectors return primitives.
 */
export function useHiddenRollupTooltip(hidden: WorkspaceWithTabs[]): string {
	const members = useMemo(
		() =>
			hidden.map((ws) => ({
				id: ws.id,
				name: ws.name,
				layouts: tabLayoutsOf(ws.tabs),
			})),
		[hidden],
	);

	return usePtyActivityStore((s) =>
		members
			.map((m) => {
				const status = computeWorkspaceDotStatus(
					m.id,
					m.layouts,
					s.activities,
					s.openedWorkspaceIds,
					s.panePtyMap,
				);
				return `${m.name} — ${dotStatusLabel(status)}`;
			})
			.join("\n"),
	);
}
