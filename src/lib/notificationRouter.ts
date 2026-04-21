import { getCurrentWindow } from "@tauri-apps/api/window";
import { onAction } from "@tauri-apps/plugin-notification";
import { useGitChangesStore } from "../stores/gitChangesStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { PaneNode } from "./types";

interface PtyExtra {
	type: "pty";
	paneId?: string;
	workspaceId?: string;
	tabId?: string;
}

interface PrExtra {
	type: "pr";
	workspaceId?: string;
}

type NotificationExtra = PtyExtra | PrExtra;

/**
 * Search all workspaces/tabs to find which workspace and tab contain a given pane.
 */
export function findPaneLocation(
	paneId: string,
): { workspaceId: string; tabId: string } | null {
	const { workspaces } = useWorkspaceStore.getState();

	for (const workspace of workspaces) {
		for (const tab of workspace.tabs) {
			try {
				const layout = JSON.parse(tab.layoutJson) as PaneNode;
				if (containsPane(layout, paneId)) {
					return { workspaceId: workspace.id, tabId: tab.id };
				}
			} catch {
				/* skip malformed layout */
			}
		}
	}
	return null;
}

function containsPane(node: PaneNode, paneId: string): boolean {
	if (node.type === "terminal") return node.id === paneId;
	return containsPane(node.first, paneId) || containsPane(node.second, paneId);
}

function isNotificationExtra(value: unknown): value is NotificationExtra {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	return obj.type === "pty" || obj.type === "pr";
}

export function handleNotificationClick(
	extra: Record<string, unknown> | undefined,
): void {
	getCurrentWindow().setFocus();

	if (!extra || !isNotificationExtra(extra)) return;

	const wsStore = useWorkspaceStore.getState();

	if (extra.type === "pty") {
		const { workspaceId, tabId, paneId } = extra;
		if (!workspaceId || !tabId) return;

		const workspace = wsStore.workspaces.find(
			(w: { id: string }) => w.id === workspaceId,
		);
		if (!workspace) return;

		wsStore.beginWorkspaceSwitch(workspaceId);
		wsStore.setActiveTab(workspaceId, tabId);
		if (paneId) {
			wsStore.setFocusedPane(paneId);
		}
		wsStore.setActiveView(workspaceId, "terminal");
	} else if (extra.type === "pr") {
		const { workspaceId } = extra;
		if (!workspaceId) return;

		const workspace = wsStore.workspaces.find(
			(w: { id: string }) => w.id === workspaceId,
		);
		if (!workspace) return;

		wsStore.beginWorkspaceSwitch(workspaceId);
		useGitChangesStore.getState().setPanel(true);
	}
}

export function initNotificationListener(): void {
	onAction((notification) => {
		handleNotificationClick(
			notification.extra as Record<string, unknown> | undefined,
		);
	});
}
