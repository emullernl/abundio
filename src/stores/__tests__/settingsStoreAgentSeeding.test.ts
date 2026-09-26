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

const builtin = (id: string, enabled: boolean): CodingAgent => ({
	id,
	name: id,
	command: id,
	builtin: true,
	enabled,
});

const custom = (id: string, enabled: boolean): CodingAgent => ({
	id,
	name: id,
	command: id,
	builtin: false,
	enabled,
});

const watched = () =>
	useSettingsStore
		.getState()
		.agents.filter((a) => a.enabled)
		.map((a) => a.id);

describe("settingsStore.matchAgentsToInstalled", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSettingsStore.setState({
			agentHooksEnabled: true,
			agents: [builtin("claude", true), builtin("codex", true)],
		});
	});

	it("switches built-ins to match what is installed", async () => {
		const outcome = await useSettingsStore
			.getState()
			.matchAgentsToInstalled(new Set(["claude"]));

		expect(outcome).toBe("changed");
		expect(watched()).toEqual(["claude"]);
	});

	// `provisionStartup` has already run for all built-ins by the time the
	// first-run scan lands, so an Agent seeded off must lose its hooks here.
	it("re-syncs hook provisioning to the new toggles", async () => {
		await useSettingsStore
			.getState()
			.matchAgentsToInstalled(new Set(["claude"]));

		expect(mockProvision).toHaveBeenCalledWith(true, ["claude"]);
	});

	it("does not provision when the global Status Hooks setting is off", async () => {
		useSettingsStore.setState({ agentHooksEnabled: false });

		const outcome = await useSettingsStore
			.getState()
			.matchAgentsToInstalled(new Set(["claude"]));

		expect(outcome).toBe("changed");
		expect(watched()).toEqual(["claude"]);
		expect(mockProvision).not.toHaveBeenCalled();
	});

	// An empty scan means the login shell timed out far more often than it
	// means the machine has no coding CLIs. See ADR-0037.
	it("changes nothing on an empty scan", async () => {
		const outcome = await useSettingsStore
			.getState()
			.matchAgentsToInstalled(new Set());

		expect(outcome).toBe("empty-scan");
		expect(watched()).toEqual(["claude", "codex"]);
		expect(mockProvision).not.toHaveBeenCalled();
	});

	// The identity check exists to skip a redundant store write, a re-provision
	// and the cross-Window broadcast that rides on it.
	it("skips the write and the provision when nothing would move", async () => {
		useSettingsStore.setState({
			agents: [builtin("claude", true), builtin("codex", false)],
		});
		const before = useSettingsStore.getState().agents;

		const outcome = await useSettingsStore
			.getState()
			.matchAgentsToInstalled(new Set(["claude"]));

		expect(outcome).toBe("already-matching");
		expect(useSettingsStore.getState().agents).toBe(before);
		expect(mockProvision).not.toHaveBeenCalled();
	});

	it("leaves a custom agent alone whether or not it is installed", async () => {
		useSettingsStore.setState({
			agents: [builtin("claude", true), custom("mine", true)],
		});

		await useSettingsStore.getState().matchAgentsToInstalled(new Set(["mine"]));

		expect(watched()).toEqual(["mine"]);
	});
});

describe("settingsStore.pruneRetiredAgents", () => {
	const retired: CodingAgent = {
		...custom("aider", true),
		retiredBuiltin: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		useSettingsStore.setState({
			agentHooksEnabled: true,
			agents: [builtin("claude", true), retired],
		});
	});

	it("removes a converted agent that is not installed and re-syncs hooks", async () => {
		const changed = await useSettingsStore
			.getState()
			.pruneRetiredAgents(new Set(["claude"]));

		expect(changed).toBe(true);
		expect(useSettingsStore.getState().agents.map((a) => a.id)).toEqual([
			"claude",
		]);
		expect(mockProvision).toHaveBeenCalledWith(true, ["claude"]);
	});

	it("keeps an installed one and clears its marker", async () => {
		await useSettingsStore
			.getState()
			.pruneRetiredAgents(new Set(["claude", "aider"]));

		const aider = useSettingsStore
			.getState()
			.agents.find((a) => a.id === "aider");
		expect(aider?.retiredBuiltin).toBeUndefined();
	});

	it("skips the write and the provision on an empty scan", async () => {
		const before = useSettingsStore.getState().agents;

		const changed = await useSettingsStore
			.getState()
			.pruneRetiredAgents(new Set());

		expect(changed).toBe(false);
		expect(useSettingsStore.getState().agents).toBe(before);
		expect(mockProvision).not.toHaveBeenCalled();
	});

	it("skips the provision once nothing is marked", async () => {
		useSettingsStore.setState({ agents: [builtin("claude", true)] });

		const changed = await useSettingsStore
			.getState()
			.pruneRetiredAgents(new Set(["claude"]));

		expect(changed).toBe(false);
		expect(mockProvision).not.toHaveBeenCalled();
	});
});
