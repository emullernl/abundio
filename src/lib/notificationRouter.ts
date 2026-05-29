import { getCurrentWindow } from "@tauri-apps/api/window";
import { onAction } from "@tauri-apps/plugin-notification";
import { useWindowUiStore } from "../stores/windowUiStore";
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
	if (node.type !== "split") return node.id === paneId;
	return containsPane(node.first, paneId) || containsPane(node.second, paneId);
}

/**
 * True when a pane is on screen — i.e. it lives in the active tab of the
 * active workspace. Does not consider window focus (callers gate on that
 * separately). Used to decide whether a "waiting" agent needs a notification.
 */
export function isPaneVisible(paneId: string): boolean {
	const loc = findPaneLocation(paneId);
	if (!loc) return false;
	const ws = useWorkspaceStore.getState();
	if (ws.activeWorkspaceId !== loc.workspaceId) return false;
	return ws.getActiveTab()?.id === loc.tabId;
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
	} else if (extra.type === "pr") {
		const { workspaceId } = extra;
		if (!workspaceId) return;

		const workspace = wsStore.workspaces.find(
			(w: { id: string }) => w.id === workspaceId,
		);
		if (!workspace) return;

		wsStore.beginWorkspaceSwitch(workspaceId);
		// PR notification was clicked — open the right sidebar and route to the
		// Git tab so the PR section becomes visible. The PR section's own
		// collapsed state is preserved; if the user keeps PRs collapsed, the
		// section header is still pinned at the bottom, hinting at where the PR
		// list lives.
		const ui = useWindowUiStore.getState();
		ui.setRightSidebarOpen(true);
		ui.setRightSidebarActiveTab("git");
	}
}

export function initNotificationListener(): void {
	onAction((notification) => {
		handleNotificationClick(
			notification.extra as Record<string, unknown> | undefined,
		);
	});
}
