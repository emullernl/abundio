import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	activityAction,
	applyAgentExit,
	applySessionEnd,
	isSessionEnd,
} from "../agentModeEvents";
import { onSessionEnd } from "../agentTurnTracker";

vi.mock("../agentTurnTracker", async (importOriginal) => ({
	...(await importOriginal<typeof import("../agentTurnTracker")>()),
	onSessionEnd: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: vi.fn(),
}));

const PTY = "pty-1";
const PANE = "pane-1";

function entry() {
	return usePtyActivityStore.getState().activities[PTY];
}

function startAgent(agentId = "copilot") {
	const s = usePtyActivityStore.getState();
	s.initPty(PTY);
	s.setAgentPty(PTY, agentId);
	s.applyHookEvent(PTY, "active", true);
}

describe("applySessionEnd", () => {
	beforeEach(() => {
		vi.mocked(onSessionEnd).mockClear();
		usePtyActivityStore.setState({
			activities: {},
			agentPtyIds: new Set(),
			detectedAgentIds: {},
		});
	});

	it("keeps a running Agent in agent mode through /clear", () => {
		startAgent();
		applySessionEnd(PTY);

		const s = usePtyActivityStore.getState();
		expect(entry().detectionMode).toBe("agent");
		expect(s.agentPtyIds.has(PTY)).toBe(true);
		expect(s.detectedAgentIds[PTY]).toBe("copilot");
		// The user just typed /clear, so nothing is left unacknowledged.
		expect(entry().state).toBe("idle");
		expect(onSessionEnd).toHaveBeenCalledWith(PTY);
	});

	it("leaves agent mode only when the shell reports command_end", () => {
		startAgent();
		applySessionEnd(PTY); // /exit fires the Session end first…
		expect(entry().detectionMode).toBe("agent");

		expect(applyAgentExit(PTY, PANE)).toBe(true); // …then command_end
		expect(entry().detectionMode).toBe("shell");
	});

	it("does not resurrect agent mode when it lands after command_end", () => {
		startAgent();
		applyAgentExit(PTY, PANE);

		applySessionEnd(PTY);

		expect(entry().detectionMode).toBe("shell");
		expect(usePtyActivityStore.getState().agentPtyIds.has(PTY)).toBe(false);
		// The Turn is still finalized: command_end drops agent mode without
		// closing it, so this hook is what ends the session in telemetry.
		expect(onSessionEnd).toHaveBeenCalledWith(PTY);
	});
});

describe("applyAgentExit", () => {
	const stampAgentOnPane = vi.fn();

	beforeEach(() => {
		stampAgentOnPane.mockClear();
		useWorkspaceStore.setState({ stampAgentOnPane });
		usePtyActivityStore.setState({
			activities: {},
			agentPtyIds: new Set(),
			detectedAgentIds: {},
		});
	});

	it("drops agent mode and forgets the Agent so it does not relaunch", () => {
		startAgent();

		expect(applyAgentExit(PTY, PANE)).toBe(true);

		expect(entry().detectionMode).toBe("shell");
		expect(usePtyActivityStore.getState().agentPtyIds.has(PTY)).toBe(false);
		expect(stampAgentOnPane).toHaveBeenCalledWith(PANE, undefined);
	});

	it("is a no-op for a shell-mode PTY, leaving shell bookkeeping to the caller", () => {
		usePtyActivityStore.getState().initPty(PTY);

		expect(applyAgentExit(PTY, PANE)).toBe(false);

		expect(entry().detectionMode).toBe("shell");
		expect(stampAgentOnPane).not.toHaveBeenCalled();
	});
});

describe("isSessionEnd", () => {
	it("routes a Session end around adoption, so it cannot resurrect an exited Agent", () => {
		expect(isSessionEnd("sessionReset")).toBe(true);
	});

	it("adopts agent mode for every other transition", () => {
		for (const t of [
			"active",
			"waiting",
			"ready",
			"idle",
			"error",
			"errorMidTurn",
			"resume",
			"attach",
		] as const) {
			expect(isSessionEnd(t)).toBe(false);
		}
	});
});

describe("activityAction", () => {
	it("treats an agent-mode commandFinished as the Agent exiting, even while suppressed", () => {
		// An unfocused pane may never clear suppressActivity, so gating the exit
		// on it would strand the pane in agent mode.
		expect(activityAction("commandFinished", "agent", true)).toBe("agentExit");
		expect(activityAction("commandFinished", "agent", false)).toBe("agentExit");
	});

	it("ignores an agent-mode commandStarted (the Agent's own launch)", () => {
		expect(activityAction("commandStarted", "agent", false)).toBe("ignore");
	});

	it("does shell bookkeeping in shell mode unless suppressed", () => {
		expect(activityAction("commandStarted", "shell", false)).toBe("shell");
		expect(activityAction("commandFinished", "shell", false)).toBe("shell");
		expect(activityAction("commandFinished", "shell", true)).toBe("ignore");
		expect(activityAction("commandFinished", undefined, false)).toBe("ignore");
	});
});
