import { onAction } from "@tauri-apps/plugin-notification";
import { useWindowUiStore } from "../stores/windowUiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { appWindow } from "./appWindow";
import { isDemoMode } from "./demo";
import { fleetConsoleShowing, isShownAsFleetTile } from "./fleetFocus";
import { findPaneLocation, revealPane } from "./paneLocation";

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

export { findPaneLocation } from "./paneLocation";

/**
 * True when a pane is on screen. In the Workspace view that means it lives in
 * the active tab of the active workspace; while the Fleet Console is on
 * screen it means the pane is one of its tiles, and the Workspace view behind
 * the console counts as hidden (ADR-0040). Does not consider window focus
 * (callers gate on that separately). Used to decide whether a "waiting" agent
 * needs a notification.
 */
export function isPaneVisible(paneId: string): boolean {
	if (fleetConsoleShowing()) return isShownAsFleetTile(paneId);
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
	appWindow()?.setFocus();

	if (!extra || !isNotificationExtra(extra)) return;

	const wsStore = useWorkspaceStore.getState();

	if (extra.type === "pty") {
		const { workspaceId, tabId, paneId } = extra;
		if (!workspaceId || !tabId) return;

		const workspace = wsStore.workspaces.find(
			(w: { id: string }) => w.id === workspaceId,
		);
		if (!workspace) return;

		// In the console, an agent's notification lands on its tile, so the
		// answer can be typed right there. Anything that is not a tile (a
		// shell's Error) leaves the console for the Workspace view.
		if (paneId && isShownAsFleetTile(paneId)) {
			useWindowUiStore.getState().setFocusedTile(paneId);
			return;
		}
		useWindowUiStore.getState().setFleetConsoleOpen(false);
		revealPane(paneId ?? null, workspaceId, tabId);
	} else if (extra.type === "pr") {
		const { workspaceId } = extra;
		if (!workspaceId) return;

		const workspace = wsStore.workspaces.find(
			(w: { id: string }) => w.id === workspaceId,
		);
		if (!workspace) return;

		useWindowUiStore.getState().setFleetConsoleOpen(false);
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
	// The notification plugin opens an IPC channel, which needs a Tauri host —
	// no-op in the browser demo and in tests.
	if (isDemoMode()) return;
	onAction((notification) => {
		handleNotificationClick(
			notification.extra as Record<string, unknown> | undefined,
		);
	});
}
