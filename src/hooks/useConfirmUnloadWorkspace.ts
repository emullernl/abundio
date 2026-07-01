import { useCallback, useState } from "react";
import { parseTabLayout } from "../lib/paneTree";
import {
	collectPtyIds,
	isShellCommandRunning,
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

export function buildUnloadWorkspaceMessage({
	hasWorkingAgent,
	hasRunningCommand,
}: WorkSignals): string {
	if (hasWorkingAgent && hasRunningCommand) {
		return "An agent is still working and a command is in progress in this workspace.";
	}
	if (hasWorkingAgent) {
		return "An agent is still working in this workspace.";
	}
	return "A command is still in progress in this workspace.";
}

/** glossary Working for an Agent: an agent-mode PTY mid-turn (`active`). A
 *  Waiting agent (blocked on a prompt) is `waiting`, not `active`, so it is
 *  deliberately excluded — see the unload-confirm plan. */
function makeIsAgentWorking(
	activities: Record<string, PtyActivityEntry>,
): (ptyId: string) => boolean {
	return (ptyId) => {
		const entry = activities[ptyId];
		return entry?.state === "active" && entry?.detectionMode === "agent";
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
	let hasWorkingAgent = false;
	let hasRunningCommand = false;
	for (const tab of ws.tabs) {
		const s = detectWorkInLayout(
			tab.layoutJson,
			isAgentWorking,
			isShellCommandRunning,
			panePtyMap,
		);
		if (s.hasWorkingAgent) hasWorkingAgent = true;
		if (s.hasRunningCommand) hasRunningCommand = true;
	}
	return { hasWorkingAgent, hasRunningCommand };
}

/** Unloading a Workspace (`closeWorkspace`) tears down every PTY in it, so a
 *  Working agent or in-progress command is lost. Confirm first when there's
 *  live work; otherwise unload straight away. */
export function useConfirmUnloadWorkspace() {
	const [pending, setPending] = useState<{
		workspaceId: string;
		signals: WorkSignals;
	} | null>(null);

	const requestUnload = useCallback((workspaceId: string) => {
		const signals = detectWorkForWorkspace(workspaceId);
		if (!signals.hasWorkingAgent && !signals.hasRunningCommand) {
			void useWorkspaceStore.getState().closeWorkspace(workspaceId);
			return;
		}
		setPending({ workspaceId, signals });
	}, []);

	const dialogProps = pending
		? {
				title: "Unload workspace?",
				message: buildUnloadWorkspaceMessage(pending.signals),
				confirmLabel: "Unload",
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

	return { requestUnload, dialogProps };
}
