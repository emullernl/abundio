import { useCallback, useState } from "react";
import type { PaneNode } from "../lib/types";
import {
	collectPtyIds,
	isShellCommandRunning,
	usePtyActivityStore,
} from "../stores/ptyActivityStore";
import { requestTabCloseWithDirtyCheck } from "../stores/tabCloseConfirmStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

export interface RunningSignals {
	hasAgent: boolean;
	hasCommand: boolean;
}

export function detectRunningInLayout(
	layoutJson: string,
	agentPtyIds: Set<string>,
	panePtyMap: Record<string, string>,
	isCommandRunning: (ptyId: string) => boolean,
): RunningSignals {
	let layout: PaneNode;
	try {
		layout = JSON.parse(layoutJson) as PaneNode;
	} catch {
		return { hasAgent: false, hasCommand: false };
	}

	const ptyIds = collectPtyIds(layout, panePtyMap);
	let hasAgent = false;
	let hasCommand = false;
	for (const ptyId of ptyIds) {
		if (agentPtyIds.has(ptyId)) hasAgent = true;
		if (isCommandRunning(ptyId)) hasCommand = true;
	}
	return { hasAgent, hasCommand };
}

export function buildCloseTerminalMessage({
	hasAgent,
	hasCommand,
}: RunningSignals): string {
	if (hasAgent && hasCommand) {
		return "An agent and a command are still running in this tab.";
	}
	if (hasAgent) {
		return "An agent is still running in this tab.";
	}
	return "A command is still running in this tab.";
}

function detectRunningForTab(tabId: string): RunningSignals {
	const tab = useWorkspaceStore
		.getState()
		.workspaces.flatMap((w) => w.tabs)
		.find((t) => t.id === tabId);
	if (!tab) return { hasAgent: false, hasCommand: false };
	const { agentPtyIds, panePtyMap } = usePtyActivityStore.getState();
	return detectRunningInLayout(
		tab.layoutJson,
		agentPtyIds,
		panePtyMap,
		isShellCommandRunning,
	);
}

export function useConfirmCloseTerminalTab() {
	const [pending, setPending] = useState<{
		tabId: string;
		signals: RunningSignals;
	} | null>(null);

	const requestClose = useCallback((tabId: string) => {
		const signals = detectRunningForTab(tabId);
		if (!signals.hasAgent && !signals.hasCommand) {
			requestTabCloseWithDirtyCheck(tabId, () =>
				useWorkspaceStore.getState().closeTab(tabId),
			);
			return;
		}
		setPending({ tabId, signals });
	}, []);

	const dialogProps = pending
		? {
				title: "Close terminal tab?",
				message: buildCloseTerminalMessage(pending.signals),
				confirmLabel: "Close tab",
				confirmVariant: "danger" as const,
				onConfirm: () => {
					const tabId = pending.tabId;
					setPending(null);
					requestTabCloseWithDirtyCheck(tabId, () =>
						useWorkspaceStore.getState().closeTab(tabId),
					);
				},
				onCancel: () => {
					setPending(null);
				},
			}
		: null;

	return { requestClose, dialogProps };
}
