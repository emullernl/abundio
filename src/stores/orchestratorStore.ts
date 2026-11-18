import { create } from "zustand";
import type { OrchestratorFileTab } from "../lib/ipc";
import type { OrchestratorSession } from "../lib/orchestrator";

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
	/** The **Orchestrator folder** is missing and cannot be made again (its
	 *  parent is gone too): the view offers to choose one or use the default
	 *  (ADR-0059). */
	missingFolder: string | null;
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
	/** The Orchestrator Agent's last known session, kept while it runs so
	 *  that picking the same Agent after it exits resumes that conversation
	 *  by id (ADR-0060). In memory only: across an app restart the pane
	 *  itself still holds it. */
	lastSession: OrchestratorSession | null;
	/** The "Open workspace…" list is open (tab strip button or the graph's
	 *  '+' node). */
	workspacePickerOpen: boolean;
	/** The Agent selected in the graph (a single click). */
	selectedPaneId: string | null;
	/** The Agent shown in the **Peek**, to the right of the graph. */
	peekPaneId: string | null;
	/** Width of the Peek's column, in px; 0 with no Peek. Measured by the
	 *  view, read by the file tabs so a selected file sits beside the Peek. */
	peekWidth: number;
	/** Keyboard focus is in the Peek's terminal: pane-scoped shortcuts
	 *  (prompt action numbers, find, copy, paste, Close pane) act on the
	 *  peeked pane, as they do on the Focused tile in the Fleet Console.
	 *  Kept when another Agent is peeked at, so focus follows the Peek. */
	peekFocused: boolean;
	/** **Orchestrator tabs** holding files (ADR-0058), in order. */
	fileTabs: OrchestratorFileTab[];
	/** The selected Orchestrator tab: a file tab's id, or null for the graph. */
	selectedTabId: string | null;
	/** A file tab with unsaved edits the user asked to close: Save / Don't
	 *  Save / Cancel is showing. */
	closingTabId: string | null;
	/** Keyboard focus is in the selected file tab (Save goes there). */
	fileTabFocused: boolean;
	/** The file search is open, over these Workspaces (Cmd+P in the view, or
	 *  a Workspace's "Open file…"). */
	fileSearch: { workspaceIds: string[] } | null;
	set: (patch: Partial<Omit<OrchestratorState, "set">>) => void;
}

export const useOrchestratorStore = create<OrchestratorState>((set) => ({
	phase: "idle",
	workspaceId: null,
	agentId: null,
	error: null,
	missingFolder: null,
	returnWorkspaceId: null,
	changingAgent: false,
	panesTop: 0,
	selectedPaneId: null,
	peekPaneId: null,
	peekFocused: false,
	peekWidth: 0,
	fileTabs: [],
	selectedTabId: null,
	fileTabFocused: false,
	closingTabId: null,
	fileSearch: null,
	workspacePickerOpen: false,
	exited: false,
	lastSession: null,
	set: (patch) => set(patch),
}));
