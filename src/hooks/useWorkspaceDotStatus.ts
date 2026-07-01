import { useMemo } from "react";
import { parseTabLayout } from "../lib/paneTree";
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
			const layout = parseTabLayout(tab.layoutJson);
			if (layout) layouts.push(layout);
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
