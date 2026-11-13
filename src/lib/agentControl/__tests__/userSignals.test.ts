import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	sent: [] as unknown[],
	visible: true,
	blurredMs: null as number | null,
	windowFocused: true,
	focusListeners: [] as ((f: boolean) => void)[],
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: (n: unknown) => h.sent.push(n),
	onAction: async () => () => {},
}));
vi.mock("../../notificationRouter", () => ({
	isPaneVisible: () => h.visible,
}));
vi.mock("../../windowFocus", () => ({
	NOTIFICATION_BLUR_THRESHOLD_MS: 3000,
	getWindowBlurredMs: () => h.blurredMs,
	isAppWindowFocused: () => h.windowFocused,
	addWindowFocusListener: (l: (f: boolean) => void) => {
		h.focusListeners.push(l);
		return () => {};
	},
}));
const sent = h.sent;

import { useAgentSignalsStore } from "../../../stores/agentSignalsStore";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { notePaneInput } from "../../paneInput";
import { requireAgentCaller } from "../handleControlRequest";
import {
	NOTIFY_POPUP_GAP_MS,
	notifyPopupAllowed,
	notifyUser,
	startSignalClearing,
} from "../userSignals";

const flags = () => useAgentSignalsStore.getState().flags;

beforeEach(() => {
	sent.length = 0;
	h.visible = true;
	h.blurredMs = null;
	h.windowFocused = true;
	useAgentSignalsStore.setState({ flags: {}, progress: {}, questions: {} });
});

describe("notifyPopupAllowed", () => {
	const base = { lastPopupAt: undefined, now: 100_000 };
	it("pops only when the user is away or the pane is out of sight", () => {
		expect(
			notifyPopupAllowed({ ...base, blurredMs: null, paneVisible: true }),
		).toBe(false);
		expect(
			notifyPopupAllowed({ ...base, blurredMs: 5000, paneVisible: true }),
		).toBe(true);
		expect(
			notifyPopupAllowed({ ...base, blurredMs: 1000, paneVisible: false }),
		).toBe(true);
	});
	it("at most once a minute per pane", () => {
		const away = { blurredMs: 5000, paneVisible: false, now: 100_000 };
		expect(notifyPopupAllowed({ ...away, lastPopupAt: 100_000 - 1000 })).toBe(
			false,
		);
		expect(
			notifyPopupAllowed({
				...away,
				lastPopupAt: 100_000 - NOTIFY_POPUP_GAP_MS,
			}),
		).toBe(true);
	});
});

describe("notifyUser", () => {
	it("flags the pane, and pops once while the user is away", () => {
		h.visible = false;
		expect(notifyUser("pane-n1", "Agent One", "Tests are green").popup).toBe(
			true,
		);
		expect(flags()["pane-n1"].message).toBe("Tests are green");
		expect(sent).toHaveLength(1);
		expect(JSON.stringify(sent[0])).toContain("Agent One: Tests are green");
		// A second call inside the minute only updates the message.
		expect(notifyUser("pane-n1", "Agent One", "Still green").popup).toBe(false);
		expect(flags()["pane-n1"].message).toBe("Still green");
		expect(sent).toHaveLength(1);
	});
	it("flags without a popup when the user is looking", () => {
		expect(notifyUser("pane-n2", "A", "hi").popup).toBe(false);
		expect(flags()["pane-n2"]).toBeDefined();
		expect(sent).toHaveLength(0);
	});
});

describe("when a flag clears", () => {
	let stop: () => void;
	beforeEach(() => {
		stop = startSignalClearing();
	});
	afterEach(() => stop());

	it("on typing into the pane", () => {
		useAgentSignalsStore.getState().setFlag("a", "look");
		notePaneInput("b");
		expect(flags().a).toBeDefined();
		notePaneInput("a");
		expect(flags().a).toBeUndefined();
	});

	it("when focus moves to the pane, only with the Window focused", () => {
		useAgentSignalsStore.getState().setFlag("a", "look");
		h.windowFocused = false;
		useWorkspaceStore.setState({ focusedPaneId: "a" });
		expect(flags().a).toBeDefined();
		// Coming back to the Window with that pane focused clears it.
		h.windowFocused = true;
		for (const l of h.focusListeners) l(true);
		expect(flags().a).toBeUndefined();
		useWorkspaceStore.setState({ focusedPaneId: null });
	});
});

describe("requireAgentCaller", () => {
	it("refuses a plain shell and allows an Agent", () => {
		usePtyActivityStore.setState({
			activities: {
				sh: {
					state: "idle",
					lastOutputAt: null,
					hasEverReceivedOutput: true,
					detectionMode: "shell",
					hookDriven: false,
					shellCommandRunning: false,
				},
				ag: {
					state: "active",
					lastOutputAt: null,
					hasEverReceivedOutput: true,
					detectionMode: "agent",
					hookDriven: true,
					shellCommandRunning: false,
				},
			},
		});
		const caller = (ptyId: string) => ({
			ptyId,
			paneId: "p",
			workspaceId: "ws",
		});
		expect(() => requireAgentCaller(caller("sh"))).toThrow(
			expect.objectContaining({ code: "agents_only" }),
		);
		expect(() => requireAgentCaller(caller("none"))).toThrow();
		expect(() => requireAgentCaller(caller("ag"))).not.toThrow();
	});
});
