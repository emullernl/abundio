import { useMemo } from "react";
import { parseTabLayout } from "../lib/paneTree";
import type { PaneNode, Tab, WorkspaceWithTabs } from "../lib/types";
import {
	computeTabRollups,
	computeWorkspaceRollups,
	type DotStatus,
	decodeRollups,
	dotStatusLabel,
	encodeRollups,
	mergeRollups,
	mostUrgentStatus,
	type Rollups,
	usePtyActivityStore,
	type WorkspaceRollups,
} from "../stores/ptyActivityStore";
import { useWorkspaceGitStore } from "../stores/workspaceGitStore";

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

// Rollups are objects, and the store changes on every status transition in
// any pane. Selecting an encoded key (a primitive) lets Zustand's default
// equality bail the re-render until this rollup actually changes; the object
// is rebuilt from the key. See "Rollup keys" in ptyActivityStore.
type StoreState = ReturnType<typeof usePtyActivityStore.getState>;

/** Separates hidden members' keys; never produced by `encodeRollups`. */
const MEMBER_SEPARATOR = ";";

/** A Workspace's **Agent rollup** and **Terminal rollup**. */
export function useWorkspaceRollups(
	workspace: WorkspaceWithTabs,
): WorkspaceRollups {
	const tabLayouts = useMemo(
		() => tabLayoutsOf(workspace.tabs),
		[workspace.tabs],
	);
	const key = usePtyActivityStore((s: StoreState) =>
		encodeRollups(
			computeWorkspaceRollups(
				workspace.id,
				tabLayouts,
				s.activities,
				s.openedWorkspaceIds,
				s.panePtyMap,
			),
		),
	);
	return useMemo(() => decodeRollups(key), [key]);
}

/** A Tab's **Agent rollup** and **Terminal rollup**. */
export function useTabRollups(tab: Tab): Rollups {
	const key = usePtyActivityStore((s: StoreState) =>
		encodeRollups(computeTabRollups(tab, s.activities, s.panePtyMap)),
	);
	return useMemo(() => {
		const { agent, terminal } = decodeRollups(key);
		return { agent, terminal };
	}, [key]);
}

/** What a Folded set's Primary row reports for the members it hides. */
export interface HiddenRollup extends Rollups {
	count: number;
	/** Every hidden member was never opened and has nothing to report. */
	notOpened: boolean;
	/** The one status the narrow sidebar's badge has room for. */
	badge: DotStatus;
	/** At least one hidden member is a **Dirty workspace** — folding a set
	 *  must never hide uncommitted work. */
	dirty: boolean;
	/** One `name — Status` line per hidden worktree, in render order, each at
	 *  the more urgent of that member's two rollups, ending in `· uncommitted`
	 *  when that member is dirty. */
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

	const key = usePtyActivityStore((s: StoreState) =>
		members
			.map((m) =>
				encodeRollups(
					computeWorkspaceRollups(
						m.id,
						m.layouts,
						s.activities,
						s.openedWorkspaceIds,
						s.panePtyMap,
					),
				),
			)
			.join(MEMBER_SEPARATOR),
	);

	// One character per member ("1" dirty, "0" not): a primitive, so the row
	// re-renders only when some hidden member's dirtiness actually flips.
	const dirtyKey = useWorkspaceGitStore((s) =>
		members.map((m) => (s.uncommittedById[m.id]?.dirty ? "1" : "0")).join(""),
	);

	return useMemo(() => {
		if (members.length === 0) return undefined;
		const perMember = key.split(MEMBER_SEPARATOR).map(decodeRollups);
		const merged = mergeRollups(perMember);
		const notOpened = perMember.every((r) => r.notOpened);
		return {
			...merged,
			count: members.length,
			notOpened,
			badge: mostUrgentStatus(merged),
			dirty: dirtyKey.includes("1"),
			membersTooltip: members
				.map(
					(m, i) =>
						`${m.name} — ${memberLabel(perMember[i])}${dirtyKey[i] === "1" ? " · uncommitted" : ""}`,
				)
				.join("\n"),
		};
	}, [members, key, dirtyKey]);
}
