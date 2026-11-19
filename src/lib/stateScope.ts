/**
 * Which of the Window's Workspace state is **shared** and which is **view**
 * (docs/plans/remote-hosts.md phase 4, ADR-0062).
 *
 * - **shared**: the Profile's work, the same for every Client of its Host.
 *   It comes from Rust (layouts and Tabs through `layoutSync.ts`, status
 *   through `statusSync.ts`), or from the Host itself (PTYs, folders).
 * - **view**: this Window's own way of looking at it. Never sent to another
 *   Client, and two Windows may differ.
 *
 * Every data field of `workspaceStore` and `ptyActivityStore` is listed
 * (`stateScope.test.ts`): a new field must pick one.
 */
export type StateScope = "shared" | "view";

export const WORKSPACE_STATE_SCOPE = {
	/** Workspaces, their Tabs and layouts. */
	workspaces: "shared",
	/** A Host fact: which Workspace folders are missing there. */
	missingFolderIds: "shared",
	/** A Host fact: which PTYs run or have exited. */
	ptyStatuses: "shared",
	activeWorkspaceId: "view",
	switchingWorkspaceId: "view",
	activeTabByWorkspace: "view",
	focusedPaneId: "view",
	focusedPaneByTab: "view",
	searchPaneId: "view",
	workspacesInitialized: "view",
} as const satisfies Record<string, StateScope>;

export const PTY_ACTIVITY_STATE_SCOPE = {
	/** Pane status (Rust is the authority). */
	activities: "shared",
	titles: "shared",
	panePtyMap: "shared",
	runningCommands: "shared",
	cwds: "shared",
	/** The Profile's **Opened workspaces** (its restore list). */
	openedWorkspaceIds: "shared",
	agentPtyIds: "shared",
	detectedAgentIds: "shared",
} as const satisfies Record<string, StateScope>;
