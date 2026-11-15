import { beforeEach, describe, expect, it, vi } from "vitest";

const write = vi.fn((_ptyId: string, _data: string) => Promise.resolve());
const setAgentPty = vi.fn();
const stampAgentOnPane = vi.fn();
let terminals: Record<string, { ptyId: string }> = {};
let activities: Record<string, { detectionMode: string }> = {};

vi.mock("../ipc", () => ({
	pty: { write: (ptyId: string, data: string) => write(ptyId, data) },
}));
vi.mock("../terminalManager", () => ({
	getTerminal: (paneId: string) => terminals[paneId],
}));
vi.mock("../../stores/ptyActivityStore", () => ({
	usePtyActivityStore: { getState: () => ({ setAgentPty, activities }) },
}));
vi.mock("../../stores/workspaceStore", () => ({
	useWorkspaceStore: { getState: () => ({ stampAgentOnPane }) },
}));
vi.mock("../../stores/settingsStore", () => ({
	useSettingsStore: {
		getState: () => ({
			agents: [
				{
					id: "claude",
					name: "Claude Code",
					command: "claude",
					args: ["--model", "opus"],
					enabled: true,
				},
			],
		}),
	},
}));

import { typedLaunch } from "../typedLaunch";

describe("typedLaunch", () => {
	beforeEach(() => {
		write.mockClear();
		setAgentPty.mockClear();
		stampAgentOnPane.mockClear();
		terminals = { p1: { ptyId: "pty-1" } };
		activities = {};
	});

	// The stamp is the irreversible half: replacing the pane's Agent drops its
	// session id and its handle.
	it("neither types nor stamps into a pane already running an Agent", () => {
		activities = { "pty-1": { detectionMode: "agent" } };
		expect(typedLaunch("p1", "claude")).toBe(false);
		expect(write).not.toHaveBeenCalled();
		expect(setAgentPty).not.toHaveBeenCalled();
		expect(stampAgentOnPane).not.toHaveBeenCalled();
	});

	it("types the Agent's launch line with CR, enters agent mode and stamps the pane", () => {
		expect(typedLaunch("p1", "claude")).toBe(true);
		expect(write).toHaveBeenCalledWith("pty-1", "claude --model opus\r");
		expect(setAgentPty).toHaveBeenCalledWith("pty-1");
		expect(stampAgentOnPane).toHaveBeenCalledWith("p1", "claude");
	});

	it("does nothing when the pane has no PTY yet", () => {
		terminals = {};
		expect(typedLaunch("p1", "claude")).toBe(false);
		expect(write).not.toHaveBeenCalled();
		expect(stampAgentOnPane).not.toHaveBeenCalled();
	});

	it("does nothing for an unknown Agent", () => {
		expect(typedLaunch("p1", "gone")).toBe(false);
		expect(write).not.toHaveBeenCalled();
		expect(setAgentPty).not.toHaveBeenCalled();
	});
});
