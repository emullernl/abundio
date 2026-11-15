import { useMemo } from "react";
import {
	badgeAgents,
	type OrchestratorBadge,
	orchestratorBadge,
} from "../lib/orchestratorBadge";
import { isOrchestrator } from "../lib/workspaceKind";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

/**
 * The **Orchestrator badge** for this Window's Profile, or `null` while no
 * Agent runs in the Orchestrator workspace. Subscribes through a string key,
 * so a status change anywhere else does not re-render the bar.
 */
export function useOrchestratorBadge(): OrchestratorBadge | null {
	const tabs = useWorkspaceStore(
		(s) => s.workspaces.find((w) => isOrchestrator(w))?.tabs,
	);
	const key = usePtyActivityStore((s) => {
		if (!tabs) return "";
		const badge = orchestratorBadge(
			badgeAgents(tabs, s.panePtyMap, s.activities),
		);
		return badge ? JSON.stringify(badge) : "";
	});
	return useMemo(
		() => (key ? (JSON.parse(key) as OrchestratorBadge) : null),
		[key],
	);
}
