import { useMemo } from "react";
import { parseTabLayout } from "../lib/paneTree";
import type { PaneNode, Tab, WorkspaceWithTabs } from "../lib/types";
import {
	computeTabRollups,
	computeWorkspaceRollups,
	type DotStatus,
	dotStatusLabel,
	mergeRollups,
	mostUrgentStatus,
	type Rollups,
	usePtyActivityStore,
	type WorkspaceRollups,
} from "../stores/ptyActivityStore";

/** A workspace's parsed tab layouts — the shape every rollup computation
 *  takes. Shared by the per-workspace hook and the Hidden rollup hook. */
function tabLayoutsOf(tabs: WorkspaceWithTabs["tabs"]): PaneNode[] {
	const layouts: PaneNode[] = [];
	for (const tab of tabs) {
		const layout = parseTabLayout(tab.layoutJson);
		if (layout) layouts.push(layout);
	}
	return layouts;
}

// Rollups are objects, and the store ticks on every PTY activity. Selecting a
// serialized key (a primitive) lets Zustand's default equality bail the
// re-render until a count actually changes; the object is rebuilt from it.
type StoreState = ReturnType<typeof usePtyActivityStore.getState>;

function useRollupsKey<T>(select: (s: StoreState) => string): T {
	const key = usePtyActivityStore(select);
	return useMemo(() => JSON.parse(key) as T, [key]);
}

/** A Workspace's **Agent rollup** and **Terminal rollup**. */
export function useWorkspaceRollups(
	workspace: WorkspaceWithTabs,
): WorkspaceRollups {
	const tabLayouts = useMemo(
		() => tabLayoutsOf(workspace.tabs),
		[workspace.tabs],
	);
	return useRollupsKey((s) =>
		JSON.stringify(
			computeWorkspaceRollups(
				workspace.id,
				tabLayouts,
				s.activities,
				s.openedWorkspaceIds,
				s.panePtyMap,
			),
		),
	);
}

/** A Tab's **Agent rollup** and **Terminal rollup**. */
export function useTabRollups(tab: Tab): Rollups {
	return useRollupsKey((s) =>
		JSON.stringify(computeTabRollups(tab, s.activities, s.panePtyMap)),
	);
}

/** What a Folded set's Primary row reports for the members it hides. */
export interface HiddenRollup extends Rollups {
	count: number;
	/** Every hidden member was never opened and has nothing to report. */
	notOpened: boolean;
	/** The one status the narrow sidebar's badge has room for. */
	badge: DotStatus;
	/** One `name — Status` line per hidden worktree, in render order, each at
	 *  the more urgent of that member's two rollups. */
	membersTooltip: string;
}

function memberLabel(r: WorkspaceRollups): string {
	if (r.notOpened) return dotStatusLabel("grey");
	const status = mostUrgentStatus(r);
	// An opened worktree with no PTYs has nothing to report: Idle, not "Not opened".
	return dotStatusLabel(status === "grey" ? "green" : status);
}

/**
 * The **Hidden rollup** for a Folded set: an Agent rollup and a Terminal
 * rollup summed across the Linked worktrees whose rows are hidden, plus their
 * count and a per-member tooltip.
 *
 * Hoisted out of the rows because the rows in question are unmounted while
 * folded: this is what keeps folding from taking the sidebar's signal with it.
 * Returns `undefined` when nothing is hidden.
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

	const perMember = useRollupsKey<WorkspaceRollups[]>((s) =>
		JSON.stringify(
			members.map((m) =>
				computeWorkspaceRollups(
					m.id,
					m.layouts,
					s.activities,
					s.openedWorkspaceIds,
					s.panePtyMap,
				),
			),
		),
	);

	return useMemo(() => {
		if (members.length === 0) return undefined;
		const merged = mergeRollups(perMember);
		const notOpened = perMember.every((r) => r.notOpened);
		return {
			...merged,
			count: members.length,
			notOpened,
			badge: mostUrgentStatus(merged),
			membersTooltip: members
				.map((m, i) => `${m.name} — ${memberLabel(perMember[i])}`)
				.join("\n"),
		};
	}, [members, perMember]);
}
