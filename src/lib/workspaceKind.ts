import type { WorkspaceKind } from "./types";

type HasKind = { id: string; kind?: WorkspaceKind };

/** Whether `ws` is a Profile's Orchestrator workspace (ADR-0057). */
export function isOrchestrator(ws: HasKind | undefined | null): boolean {
	return ws?.kind === "orchestrator";
}

/**
 * The Workspaces the user works in: every one but the Orchestrator workspace,
 * which is shown only in the Orchestrator view. Every Workspace list, picker
 * and cycle goes through this.
 */
export function workWorkspaces<T extends HasKind>(list: readonly T[]): T[] {
	return list.filter((ws) => !isOrchestrator(ws));
}
