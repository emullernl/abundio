import { useMemo } from "react";
import { workWorkspaces } from "../lib/workspaceKind";
import { useWorkspaceStore } from "../stores/workspaceStore";

/** The store's Workspaces without the Orchestrator workspace (ADR-0057), as a
 *  stable array: a selector that filtered would return a new array on every
 *  store change and re-render forever. */
export function useWorkWorkspaces() {
	const all = useWorkspaceStore((s) => s.workspaces);
	return useMemo(() => workWorkspaces(all), [all]);
}
