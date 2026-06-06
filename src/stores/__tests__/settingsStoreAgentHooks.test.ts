import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the IPC surface the store touches so we can assert provisioning calls.
vi.mock("../../lib/ipc", () => ({
	agentHooks: {
		provision: vi.fn(() => Promise.resolve()),
		provisionStartup: vi.fn(() => Promise.resolve()),
	},
	updates: {
		setAutoCheck: vi.fn(() => Promise.resolve()),
	},
}));
vi.mock("../../lib/themes", () => ({
	applyTheme: vi.fn(),
	getTheme: vi.fn(() => ({ terminal: {} })),
}));
vi.mock("../../lib/terminalManager", () => ({
	setAllTerminalsFontFamily: vi.fn(),
	setAllTerminalsFontSize: vi.fn(),
	setAllTerminalsScrollback: vi.fn(),
	setAllTerminalsTheme: vi.fn(),
	setActivityByteThreshold: vi.fn(),
	setWebglEnabled: vi.fn(),
}));

import { agentHooks } from "../../lib/ipc";
import type { CodingAgent } from "../../lib/types";
import { useSettingsStore } from "../settingsStore";

const mockProvision = vi.mocked(agentHooks.provision);

const agent = (id: string, enabled: boolean): CodingAgent => ({
	id,
	name: id,
	command: id,
	builtin: true,
	enabled,
});

describe("settingsStore — per-agent hook provisioning", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSettingsStore.setState({
			agentHooksEnabled: true,
			agents: [agent("claude", true), agent("codex", true)],
		});
	});

	it("toggling an agent OFF re-provisions without that agent", () => {
		useSettingsStore.getState().toggleAgent("codex");
		expect(mockProvision).toHaveBeenCalledWith(true, ["claude"]);
	});

	it("toggling an agent ON re-provisions including it", () => {
		useSettingsStore.setState({
			agents: [agent("claude", true), agent("codex", false)],
		});
		useSettingsStore.getState().toggleAgent("codex");
		expect(mockProvision).toHaveBeenCalledWith(true, ["claude", "codex"]);
	});

	it("toggling an agent does NOT provision when global hooks are off", () => {
		useSettingsStore.setState({ agentHooksEnabled: false });
		useSettingsStore.getState().toggleAgent("codex");
		expect(mockProvision).not.toHaveBeenCalled();
	});

	it("enabling the global setting provisions only the enabled agents", () => {
		useSettingsStore.setState({
			agentHooksEnabled: false,
			agents: [agent("claude", true), agent("codex", false)],
		});
		useSettingsStore.getState().setAgentHooksEnabled(true);
		expect(mockProvision).toHaveBeenCalledWith(true, ["claude"]);
	});
});
