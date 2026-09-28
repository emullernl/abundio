import { useCallback, useState } from "react";
import { isBusyPty } from "../lib/busyPty";
import { parseTabLayout } from "../lib/paneTree";
import {
	collectPtyIds,
	type PtyActivityEntry,
	usePtyActivityStore,
} from "../stores/ptyActivityStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

export interface WorkSignals {
	hasWorkingAgent: boolean;
	hasRunningCommand: boolean;
}

/** Does any PTY in this layout hold a Working agent or an in-progress command?
 *  Pure: callers supply the predicates so this stays trivially testable. */
export function detectWorkInLayout(
	layoutJson: string,
	isAgentWorking: (ptyId: string) => boolean,
	isCommandRunning: (ptyId: string) => boolean,
	panePtyMap: Record<string, string>,
): WorkSignals {
	const layout = parseTabLayout(layoutJson);
	if (!layout) return { hasWorkingAgent: false, hasRunningCommand: false };
	let hasWorkingAgent = false;
	let hasRunningCommand = false;
	for (const ptyId of collectPtyIds(layout, panePtyMap)) {
		if (isAgentWorking(ptyId)) hasWorkingAgent = true;
		if (isCommandRunning(ptyId)) hasRunningCommand = true;
	}
	return { hasWorkingAgent, hasRunningCommand };
}

/** Said after every Close workspace warning: closing is easy to mistake for
 *  deleting, and it deletes nothing (#206). */
export const CLOSE_WORKSPACE_KEEPS =
	"Closing stops its terminals. The workspace stays in your list, and no files or folders are deleted.";

export function buildCloseWorkspaceMessage({
	hasWorkingAgent,
	hasRunningCommand,
}: WorkSignals): string {
	const busy =
		hasWorkingAgent && hasRunningCommand
			? "An agent is still working and a command is in progress in this workspace."
			: hasWorkingAgent
				? "An agent is still working in this workspace."
				: "A command is still in progress in this workspace.";
	return `${busy} ${CLOSE_WORKSPACE_KEEPS}`;
}

/** glossary Working for an Agent: an agent-mode PTY mid-turn (`active`). A
 *  Waiting agent (blocked on a prompt) is `waiting`, not `active`, so it is
 *  deliberately excluded — see the unload-confirm plan (the action was then
 *  labelled "Unload Workspace"). */
function makeIsAgentWorking(
	activities: Record<string, PtyActivityEntry>,
): (ptyId: string) => boolean {
	return (ptyId) => {
		const entry = activities[ptyId];
		return entry?.state === "active" && entry?.detectionMode === "agent";
	};
}

/** A shell command in flight, read off the PTY's status entry — the same field
 *  the **Status indicator** reads, so the icon and this confirmation can never
 *  disagree about whether a terminal is busy (ADR-0034). Together with
 *  `makeIsAgentWorking` above this is exactly `isBusyPty`, split in two because
 *  the dialog names which half fired. */
function makeIsCommandRunning(
	activities: Record<string, PtyActivityEntry>,
): (ptyId: string) => boolean {
	return (ptyId) => {
		const entry = activities[ptyId];
		return entry?.detectionMode !== "agent" && isBusyPty(entry);
	};
}

/** OR the Working signals across every tab of the workspace. */
export function detectWorkForWorkspace(workspaceId: string): WorkSignals {
	const ws = useWorkspaceStore
		.getState()
		.workspaces.find((w) => w.id === workspaceId);
	if (!ws) return { hasWorkingAgent: false, hasRunningCommand: false };
	const { activities, panePtyMap } = usePtyActivityStore.getState();
	const isAgentWorking = makeIsAgentWorking(activities);
	const isCommandRunning = makeIsCommandRunning(activities);
	let hasWorkingAgent = false;
	let hasRunningCommand = false;
	for (const tab of ws.tabs) {
		const s = detectWorkInLayout(
			tab.layoutJson,
			isAgentWorking,
			isCommandRunning,
			panePtyMap,
		);
		if (s.hasWorkingAgent) hasWorkingAgent = true;
		if (s.hasRunningCommand) hasRunningCommand = true;
	}
	return { hasWorkingAgent, hasRunningCommand };
}

/** Closing a Workspace (`closeWorkspace`) tears down every PTY in it, so a
 *  Working agent or in-progress command is lost. Confirm first when there's
 *  live work; otherwise close straight away. Its folder, files, Tabs and
 *  layout are kept: it stays in the Left sidebar, ready to reopen. */
export function useConfirmCloseWorkspace() {
	const [pending, setPending] = useState<{
		workspaceId: string;
		signals: WorkSignals;
	} | null>(null);

	const requestClose = useCallback((workspaceId: string) => {
		const signals = detectWorkForWorkspace(workspaceId);
		if (!signals.hasWorkingAgent && !signals.hasRunningCommand) {
			void useWorkspaceStore.getState().closeWorkspace(workspaceId);
			return;
		}
		setPending({ workspaceId, signals });
	}, []);

	const dialogProps = pending
		? {
				title: "Close workspace?",
				message: buildCloseWorkspaceMessage(pending.signals),
				confirmLabel: "Close",
				confirmVariant: "danger" as const,
				onConfirm: () => {
					const id = pending.workspaceId;
					setPending(null);
					void useWorkspaceStore.getState().closeWorkspace(id);
				},
				onCancel: () => {
					setPending(null);
				},
			}
		: null;

	return { requestClose, dialogProps };
}
