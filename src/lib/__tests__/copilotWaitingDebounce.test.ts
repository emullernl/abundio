import { sendNotification } from "@tauri-apps/plugin-notification";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	touchLastOutput,
	usePtyActivityStore,
} from "../../stores/ptyActivityStore";
import {
	cancelPendingForPty,
	handleCopilotToolEvent,
	WAITING_DEBOUNCE_MS,
} from "../copilotWaitingDebounce";

vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: vi.fn(),
}));

vi.mock("../../lib/notificationRouter", () => ({
	findPaneLocation: vi.fn(() => ({ workspaceId: "ws-1", tabId: "tab-1" })),
	isPaneVisible: vi.fn(() => false),
}));

const focusMock = vi.hoisted(() => ({ blurredMs: 10_000 as number | null }));
vi.mock("../../lib/windowFocus", () => ({
	isAppWindowFocused: () => document.hasFocus(),
	getWindowBlurredMs: () => (document.hasFocus() ? null : focusMock.blurredMs),
	addWindowFocusListener: () => () => {},
	NOTIFICATION_BLUR_THRESHOLD_MS: 3000,
}));

const notify = vi.mocked(sendNotification);

function setupPty(ptyId: string) {
	const s = usePtyActivityStore.getState();
	s.initPty(ptyId, "agent");
	s.setAgentPty(ptyId, "copilot");
	s.registerPane(`pane-${ptyId}`, ptyId);
}

function stateOf(ptyId: string) {
	return usePtyActivityStore.getState().activities[ptyId]?.state;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	usePtyActivityStore.setState({
		activities: {},
		titles: {},
		panePtyMap: {},
		openedWorkspaceIds: new Set(),
		agentPtyIds: new Set(),
		detectedAgentIds: {},
	});
	notify.mockClear();
	// Window unfocused so the notification away-gate is open — we're testing the
	// debounce, not the gate (which has its own tests in ptyActivityStore).
	vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("copilotWaitingDebounce", () => {
	it("auto-approved tool: postToolUse within the window → never waiting, no notification", () => {
		const pty = "pty-fast";
		setupPty(pty);
		handleCopilotToolEvent(pty, "preToolUse", "edit");
		handleCopilotToolEvent(pty, "permissionRequest", "edit");
		expect(stateOf(pty)).toBe("active");

		vi.advanceTimersByTime(200);
		handleCopilotToolEvent(pty, "postToolUse", "edit");

		vi.advanceTimersByTime(WAITING_DEBOUNCE_MS * 2);
		expect(stateOf(pty)).toBe("active");
		expect(notify).not.toHaveBeenCalled();
	});

	it("genuine block: no postToolUse + quiet → waiting after the window, notifies once", () => {
		const pty = "pty-block";
		setupPty(pty);
		handleCopilotToolEvent(pty, "preToolUse", "edit");
		handleCopilotToolEvent(pty, "permissionRequest", "edit");
		expect(stateOf(pty)).toBe("active");

		vi.advanceTimersByTime(WAITING_DEBOUNCE_MS);
		expect(stateOf(pty)).toBe("waiting");
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("slow running tool: output re-arms the timer; waiting only after it goes quiet", () => {
		const pty = "pty-slow";
		setupPty(pty);
		handleCopilotToolEvent(pty, "preToolUse", "edit");
		handleCopilotToolEvent(pty, "permissionRequest", "edit");

		// Output still flowing inside the window → tool is running, not blocked.
		vi.advanceTimersByTime(1000);
		touchLastOutput(pty);
		vi.advanceTimersByTime(500); // window elapses but pane wasn't quiet → re-arm
		expect(stateOf(pty)).toBe("active");
		expect(notify).not.toHaveBeenCalled();

		// Now the pane goes quiet → the re-armed check confirms the block.
		vi.advanceTimersByTime(WAITING_DEBOUNCE_MS);
		expect(stateOf(pty)).toBe("waiting");
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("parallel same-name tools: postToolUse cancels the oldest gate; the other still resolves", () => {
		const pty = "pty-par";
		setupPty(pty);
		handleCopilotToolEvent(pty, "permissionRequest", "bash"); // gate A
		vi.advanceTimersByTime(100);
		handleCopilotToolEvent(pty, "permissionRequest", "bash"); // gate B

		// One bash finishes fast → cancels the oldest (A). B is still pending.
		handleCopilotToolEvent(pty, "postToolUse", "bash");
		expect(stateOf(pty)).toBe("active");

		vi.advanceTimersByTime(WAITING_DEBOUNCE_MS * 2);
		expect(stateOf(pty)).toBe("waiting");
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("postToolUse clears a confirmed waiting back to active", () => {
		const pty = "pty-clear";
		setupPty(pty);
		handleCopilotToolEvent(pty, "preToolUse", "edit");
		handleCopilotToolEvent(pty, "permissionRequest", "edit");
		vi.advanceTimersByTime(WAITING_DEBOUNCE_MS);
		expect(stateOf(pty)).toBe("waiting");

		handleCopilotToolEvent(pty, "postToolUse", "edit");
		expect(stateOf(pty)).toBe("active");
	});

	it("cancelPendingForPty prevents a pending gate from confirming", () => {
		const pty = "pty-cancel";
		setupPty(pty);
		handleCopilotToolEvent(pty, "preToolUse", "edit");
		handleCopilotToolEvent(pty, "permissionRequest", "edit");

		cancelPendingForPty(pty);

		vi.advanceTimersByTime(WAITING_DEBOUNCE_MS * 2);
		expect(stateOf(pty)).toBe("active");
		expect(notify).not.toHaveBeenCalled();
	});

	it("a pending timer that fires after the pty is removed is a harmless no-op", () => {
		const pty = "pty-gone";
		setupPty(pty);
		handleCopilotToolEvent(pty, "preToolUse", "edit");
		handleCopilotToolEvent(pty, "permissionRequest", "edit");

		usePtyActivityStore.getState().removePty(pty);

		expect(() => vi.advanceTimersByTime(WAITING_DEBOUNCE_MS * 2)).not.toThrow();
		expect(usePtyActivityStore.getState().activities[pty]).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();
	});

	it("read tool that never fires permissionRequest stays active", () => {
		const pty = "pty-read";
		setupPty(pty);
		handleCopilotToolEvent(pty, "preToolUse", "glob");
		handleCopilotToolEvent(pty, "postToolUse", "glob");

		vi.advanceTimersByTime(WAITING_DEBOUNCE_MS * 2);
		expect(stateOf(pty)).toBe("active");
		expect(notify).not.toHaveBeenCalled();
	});
});
