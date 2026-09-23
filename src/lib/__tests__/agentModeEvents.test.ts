import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { applyAgentExit, applySessionEnd } from "../agentModeEvents";
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
