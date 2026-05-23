import { useMemo } from "react";
import type { PaneNode, WorkspaceWithTabs } from "../lib/types";
import {
	computeWorkspaceDotStatus,
	type DotStatus,
	usePtyActivityStore,
} from "../stores/ptyActivityStore";

export function useWorkspaceDotStatus(workspace: WorkspaceWithTabs): DotStatus {
	const tabLayouts = useMemo(() => {
		const layouts: PaneNode[] = [];
		for (const tab of workspace.tabs) {
			try {
				layouts.push(JSON.parse(tab.layoutJson) as PaneNode);
			} catch {
				// ignore
			}
		}
		return layouts;
	}, [workspace.tabs]);

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
