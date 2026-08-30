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

/** What a Folded set's Primary row reports for the members it hides. */
export interface HiddenRollup {
	count: number;
	status: DotStatus;
	/** One `name — Status` line per hidden worktree, in render order. */
	tooltip: string;
}

/**
 * The **Hidden rollup** for a Folded set: the status covering the Linked
 * worktrees whose rows are hidden — at the highest precedence among them —
 * plus their count and a per-member tooltip.
 *
 * Hoisted out of the rows because the rows in question are unmounted while
 * folded: this is what keeps folding from taking the sidebar's agent signal
 * with it. Returns `undefined` when nothing is hidden.
 *
 * The single store subscription yields a **statuses key** (a primitive, so
 * Zustand's default equality bails the re-render when nothing changed); the
 * count/status/tooltip are derived from it. That matters for cost, not just
 * referential stability: the store ticks on PTY activity, and the tooltip is
 * a `title` attribute a user reads once in a while — so its string is built
 * only when a member's status actually changes, not on every tick.
 */
export function useHiddenRollup(
	hidden: WorkspaceWithTabs[],
): HiddenRollup | undefined {
	const members = useMemo(
		() =>
			hidden.map((ws) => ({
				id: ws.id,
				name: ws.name,
				layouts: tabLayoutsOf(ws.tabs),
			})),
		[hidden],
	);

	const statusesKey = usePtyActivityStore((s) =>
		members
			.map((m) =>
				computeWorkspaceDotStatus(
					m.id,
					m.layouts,
					s.activities,
					s.openedWorkspaceIds,
					s.panePtyMap,
				),
			)
			.join(","),
	);

	return useMemo(() => {
		if (members.length === 0) return undefined;
		const statuses = statusesKey.split(",") as DotStatus[];
		return {
			count: members.length,
			status: rollupDotStatus(statuses),
			tooltip: members
				.map((m, i) => `${m.name} — ${dotStatusLabel(statuses[i])}`)
				.join("\n"),
		};
	}, [members, statusesKey]);
}
