import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the IPC surface the store touches so we can assert provisioning calls.
vi.mock("../../lib/ipc", () => ({
	agentSkill: {
		provision: vi.fn(() => Promise.resolve()),
		provisionStartup: vi.fn(() => Promise.resolve()),
		status: vi.fn(() => Promise.resolve([])),
	},
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

import { agentHooks, agentSkill } from "../../lib/ipc";
import type { CodingAgent } from "../../lib/types";
import { useSettingsStore } from "../settingsStore";

const mockHooks = vi.mocked(agentHooks.provision);
const mockSkill = vi.mocked(agentSkill.provision);

const agent = (id: string, enabled: boolean): CodingAgent => ({
	id,
	name: id,
	command: id,
	builtin: true,
	enabled,
});

describe("settingsStore — Skill provisioning", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSettingsStore.setState({
			agentHooksEnabled: true,
			agentSkillEnabled: true,
			agents: [agent("claude", true), agent("codex", true)],
		});
	});

	it("re-syncs the skill when an Agent is toggled", async () => {
		await useSettingsStore.getState().toggleAgent("codex");
		expect(mockSkill).toHaveBeenCalledWith(true, ["claude"]);
		expect(mockHooks).toHaveBeenCalledWith(true, ["claude"]);
	});

	it("re-syncs the skill even while Status Hooks are off", async () => {
		useSettingsStore.setState({ agentHooksEnabled: false });
		await useSettingsStore.getState().toggleAgent("codex");
		expect(mockSkill).toHaveBeenCalledWith(true, ["claude"]);
		expect(mockHooks).not.toHaveBeenCalled();
	});

	it("turning the setting off asks Rust to remove the skill", async () => {
		await useSettingsStore.getState().setAgentSkillEnabled(false);
		expect(useSettingsStore.getState().agentSkillEnabled).toBe(false);
		expect(mockSkill).toHaveBeenCalledWith(false, ["claude", "codex"]);
	});

	it("tells Rust the setting is off when toggling an Agent with it off", async () => {
		useSettingsStore.setState({ agentSkillEnabled: false });
		await useSettingsStore.getState().toggleAgent("claude");
		expect(mockSkill).toHaveBeenCalledWith(false, ["codex"]);
	});
});
