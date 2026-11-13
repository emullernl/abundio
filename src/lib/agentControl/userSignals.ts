// Agents speaking to the user about their own pane (ADR-0056): the
// **Attention flag** (`notify`) and the **Progress line** (`progress`), and
// when each ends.

import { sendNotification } from "@tauri-apps/plugin-notification";
import { useAgentSignalsStore } from "../../stores/agentSignalsStore";
import { currentNotificationTitle } from "../../stores/profileStore";
import {
	subscribeStatusChange,
	usePtyActivityStore,
} from "../../stores/ptyActivityStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { targetPaneId } from "../fleetFocus";
import { isPaneVisible } from "../notificationRouter";
import { onPaneInput } from "../paneInput";
import { findPaneLocation } from "../paneLocation";
import {
	addWindowFocusListener,
	getWindowBlurredMs,
	isAppWindowFocused,
	NOTIFICATION_BLUR_THRESHOLD_MS,
} from "../windowFocus";

/** At most one desktop notification per pane in this long. */
export const NOTIFY_POPUP_GAP_MS = 60_000;

/** Whether a `notify` may pop a desktop notification: the pane is out of
 *  sight (as for Waiting), and none came from it in the last minute. Pure. */
export function notifyPopupAllowed(opts: {
	lastPopupAt: number | undefined;
	now: number;
	blurredMs: number | null;
	paneVisible: boolean;
}): boolean {
	if (
		opts.lastPopupAt !== undefined &&
		opts.now - opts.lastPopupAt < NOTIFY_POPUP_GAP_MS
	) {
		return false;
	}
	const away =
		opts.blurredMs !== null && opts.blurredMs >= NOTIFICATION_BLUR_THRESHOLD_MS;
	return away || !opts.paneVisible;
}

const lastPopupAt = new Map<string, number>();

/** `notify`: set the pane's Attention flag, and pop a desktop notification
 *  when the user is elsewhere (at most once a minute per pane). */
export function notifyUser(
	paneId: string,
	senderName: string,
	message: string,
): { popup: boolean } {
	useAgentSignalsStore.getState().setFlag(paneId, message);
	const now = Date.now();
	const popup = notifyPopupAllowed({
		lastPopupAt: lastPopupAt.get(paneId),
		now,
		blurredMs: getWindowBlurredMs(),
		paneVisible: isPaneVisible(paneId),
	});
	if (popup) {
		lastPopupAt.set(paneId, now);
		sendPanePopup(paneId, `${senderName}: ${message}`);
	}
	return { popup };
}

/** A desktop notification that takes the user to `paneId` when clicked. */
export function sendPanePopup(paneId: string, text: string): void {
	const loc = findPaneLocation(paneId);
	const workspaceName = loc
		? useWorkspaceStore
				.getState()
				.workspaces.find((w) => w.id === loc.workspaceId)?.name
		: undefined;
	try {
		sendNotification({
			title: currentNotificationTitle(),
			body: workspaceName ? `${workspaceName}: ${text}` : text,
			extra: loc
				? {
						type: "pty",
						paneId,
						workspaceId: loc.workspaceId,
						tabId: loc.tabId,
					}
				: { type: "pty" },
		});
	} catch {
		// Notifications may not be permitted
	}
}

function paneOfPty(ptyId: string): string | undefined {
	const map = usePtyActivityStore.getState().panePtyMap;
	for (const [paneId, id] of Object.entries(map))
		if (id === ptyId) return paneId;
	return undefined;
}

/**
 * End flags and Progress lines when they stop meaning anything:
 * - a flag clears when the user engages with its pane: focus moves to it
 *   (with the Window focused), the Window gains focus while it is the target,
 *   or the user types into it; and when a prompt starts the Agent working;
 * - everything about a pane goes when its Agent leaves agent mode.
 * Returns the unsubscribe.
 */
export function startSignalClearing(): () => void {
	const store = () => useAgentSignalsStore.getState();
	const clearIfTarget = () => {
		const target = targetPaneId();
		if (target && isAppWindowFocused() && store().flags[target]) {
			store().clearFlag(target);
		}
	};
	const unsubs = [
		useWorkspaceStore.subscribe((s, prev) => {
			if (s.focusedPaneId !== prev.focusedPaneId) clearIfTarget();
		}),
		useWindowUiStore.subscribe((s, prev) => {
			if (
				s.focusedTileId !== prev.focusedTileId ||
				s.fleetConsoleOpen !== prev.fleetConsoleOpen
			) {
				clearIfTarget();
			}
		}),
		addWindowFocusListener((focused) => {
			if (focused) clearIfTarget();
		}),
		onPaneInput((paneId) => {
			if (store().flags[paneId]) store().clearFlag(paneId);
		}),
		subscribeStatusChange(({ ptyId, prev, next }) => {
			const paneId = paneOfPty(ptyId);
			if (!paneId) return;
			if (prev.detectionMode === "agent" && next.detectionMode !== "agent") {
				store().clearPane(paneId);
				return;
			}
			// A prompt reached it: it started a new turn.
			if (next.state === "active" && prev.state !== "active") {
				if (store().flags[paneId]) store().clearFlag(paneId);
			}
		}),
	];
	return () => {
		for (const u of unsubs) u();
	};
}
