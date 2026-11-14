import { create } from "zustand";

/**
 * The Window's **Orchestrator** session (ADR-0057), in memory only: where the
 * Orchestrator view stands, and the Workspace to go back to on leaving it.
 * Written by `lib/orchestratorSession.ts`.
 */
export type OrchestratorPhase =
	/** Not entered yet in this session (or the view is closed). */
	| "idle"
	/** Creating / finding the Orchestrator workspace. */
	| "loading"
	/** No Agent picked yet for this Profile: the view shows the picker. */
	| "pick"
	/** Its Workspace is Active and its panes are on screen. */
	| "ready"
	| "error";

interface OrchestratorState {
	phase: OrchestratorPhase;
	workspaceId: string | null;
	agentId: string | null;
	error: string | null;
	/** The Active workspace before the view took over, restored on leaving. */
	returnWorkspaceId: string | null;
	/** The picker opened over a running Orchestrator (Change agent…). */
	changingAgent: boolean;
	/** Where the Orchestrator workspace's panes start, in px from the top of
	 *  the view. Measured by the view, read by the Workspace stack. */
	panesTop: number;
	/** Its Agent exited while its pane stayed: the view asks which Agent to
	 *  start (the picker), until one is chosen or the user says not now. */
	exited: boolean;
	/** The "Open workspace…" list is open (tab strip button or the graph's
	 *  '+' node). */
	workspacePickerOpen: boolean;
	/** The Agent selected in the graph (a single click). */
	selectedPaneId: string | null;
	set: (patch: Partial<Omit<OrchestratorState, "set">>) => void;
}

export const useOrchestratorStore = create<OrchestratorState>((set) => ({
	phase: "idle",
	workspaceId: null,
	agentId: null,
	error: null,
	returnWorkspaceId: null,
	changingAgent: false,
	panesTop: 0,
	selectedPaneId: null,
	workspacePickerOpen: false,
	exited: false,
	set: (patch) => set(patch),
}));
