import { useEffect, useMemo, useRef, useState } from "react";
import {
	type GridSize,
	hiddenPaneSize,
	isWatchedAgent,
	paneShare,
} from "../../lib/hiddenAgentStart";
import { collectTerminals, parseTabLayout } from "../../lib/paneTree";
import { hasPendingAgent } from "../../lib/pendingAgentRegistry";
import { shownGrid, startPtyUnlessShown } from "../../lib/terminalManager";
import type { WorkspaceWithTabs } from "../../lib/types";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { TerminalInstance } from "./TerminalInstance";

interface TerminalInfo {
	paneId: string;
	ptyId: string;
	cwd?: string;
	/** The Watched Agent this pane remembers, if any. */
	agentId?: string;
}

/**
 * A size for a pane that is not on screen, from its Tab's split ratios and a
 * terminal that is: the Focused pane when it is shown, else the first shown
 * terminal found. Null when nothing is on screen to measure against.
 */
function sizeForHiddenPane(
	paneId: string,
	workspaces: WorkspaceWithTabs[],
	focusedPaneId: string | null,
): GridSize | null {
	let target: ReturnType<typeof paneShare> = null;
	let reference: (GridSize & { share: { w: number; h: number } }) | null = null;
	for (const ws of workspaces) {
		for (const tab of ws.tabs) {
			const layout = parseTabLayout(tab.layoutJson);
			if (!layout) continue;
			target ??= paneShare(layout, paneId);
			for (const t of collectTerminals(layout)) {
				if (reference && t.id !== focusedPaneId) continue;
				const grid = shownGrid(t.id);
				const share = grid && paneShare(layout, t.id);
				if (grid && share) reference = { ...grid, share };
			}
		}
	}
	return target && reference ? hiddenPaneSize(reference, target) : null;
}

export function TerminalPool() {
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const openedWorkspaceIds = usePtyActivityStore((s) => s.openedWorkspaceIds);
	const [loadAll, setLoadAll] = useState(false);

	// Defer non-active workspace PTY spawning by 2s so the active workspace is responsive first.
	useEffect(() => {
		if (!activeWorkspaceId) return;
		const timer = setTimeout(() => setLoadAll(true), 2000);
		return () => clearTimeout(timer);
	}, [activeWorkspaceId]);

	// Collect terminals from opened workspaces so they survive workspace switches
	// but unmount cleanly when a workspace is closed.
	const terminals = useMemo(() => {
		const result: (TerminalInfo & { cwd: string })[] = [];
		for (const workspace of workspaces) {
			if (!openedWorkspaceIds.has(workspace.id)) continue;
			// The deferral puts the active workspace first. With no active
			// workspace there is nothing to put first — e.g. a Workspace opened
			// from the Fleet Console before any was activated — and waiting
			// would mean waiting for good: `loadAll` only arms once one is.
			if (!loadAll && activeWorkspaceId && workspace.id !== activeWorkspaceId) {
				continue;
			}
			for (const tab of workspace.tabs) {
				const layout = parseTabLayout(tab.layoutJson);
				if (!layout) continue;
				for (const t of collectTerminals(layout)) {
					result.push({
						paneId: t.id,
						ptyId: t.ptyId,
						cwd: t.cwd ?? workspace.rootFolder,
						agentId: t.agentId,
					});
				}
			}
		}
		return result;
	}, [workspaces, activeWorkspaceId, openedWorkspaceIds, loadAll]);

	// An Opened workspace runs every Watched Agent its layout remembers, in
	// every Tab — not only once its Tab is shown — so each is in the Agents
	// list at once. A pane that is shown within moments starts the usual way;
	// the rest start hidden, at a size worked out from the layout. Plain
	// shells keep waiting for their Tab.
	const agents = useSettingsStore((s) => s.agents);
	const hiddenStarts = useRef(new Map<string, () => void>());
	useEffect(() => {
		const starts = hiddenStarts.current;
		const present = new Set(terminals.map((t) => t.paneId));
		for (const [paneId, cancel] of starts) {
			if (present.has(paneId)) continue;
			cancel();
			starts.delete(paneId);
		}
		for (const t of terminals) {
			if (starts.has(t.paneId)) continue;
			if (!hasPendingAgent(t.paneId)) continue;
			if (!isWatchedAgent(agents, t.agentId)) continue;
			starts.set(
				t.paneId,
				startPtyUnlessShown(t.paneId, () => {
					const s = useWorkspaceStore.getState();
					return sizeForHiddenPane(t.paneId, s.workspaces, s.focusedPaneId);
				}),
			);
		}
	}, [terminals, agents]);
	useEffect(() => {
		const starts = hiddenStarts.current;
		return () => {
			for (const cancel of starts.values()) cancel();
			starts.clear();
		};
	}, []);

	return (
		<div
			data-terminal-pool=""
			style={{
				position: "fixed",
				left: "-9999px",
				visibility: "hidden",
				width: 0,
				height: 0,
			}}
		>
			{terminals.map((t) => (
				<TerminalInstance
					key={t.paneId}
					paneId={t.paneId}
					ptyId={t.ptyId}
					cwd={t.cwd}
				/>
			))}
		</div>
	);
}
