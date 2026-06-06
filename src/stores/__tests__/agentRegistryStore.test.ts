import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/ipc", () => ({
	agentRegistry: {
		listInstalled: vi.fn(),
	},
}));

import { agentRegistry as agentRegistryApi } from "../../lib/ipc";
import { useAgentRegistryStore } from "../agentRegistryStore";

const mockApi = vi.mocked(agentRegistryApi);

describe("agentRegistryStore", () => {
	beforeEach(() => {
		useAgentRegistryStore.setState({
			installedCommands: new Set(),
			loaded: false,
			loading: false,
		});
		vi.clearAllMocks();
	});

	it("load() populates installedCommands and is idempotent", async () => {
		mockApi.listInstalled.mockResolvedValue(["claude", "codex"]);

		await useAgentRegistryStore.getState().load(["claude", "codex", "gemini"]);
		await useAgentRegistryStore.getState().load(["claude", "codex", "gemini"]);

		expect(mockApi.listInstalled).toHaveBeenCalledTimes(1);
		expect([...useAgentRegistryStore.getState().installedCommands]).toEqual([
			"claude",
			"codex",
		]);
	});

	it("reload() re-scans even after a prior load (bypasses the once-guard)", async () => {
		mockApi.listInstalled.mockResolvedValueOnce(["claude"]);
		await useAgentRegistryStore.getState().load(["claude", "gemini"]);
		expect([...useAgentRegistryStore.getState().installedCommands]).toEqual([
			"claude",
		]);

		// A mid-session install: gemini now resolves on PATH.
		mockApi.listInstalled.mockResolvedValueOnce(["claude", "gemini"]);
		await useAgentRegistryStore.getState().reload(["claude", "gemini"]);

		expect(mockApi.listInstalled).toHaveBeenCalledTimes(2);
		expect([...useAgentRegistryStore.getState().installedCommands]).toEqual([
			"claude",
			"gemini",
		]);
	});

	it("on backend failure, marks loaded with an empty set", async () => {
		mockApi.listInstalled.mockRejectedValue(new Error("boom"));

		await useAgentRegistryStore.getState().load(["claude"]);

		const state = useAgentRegistryStore.getState();
		expect(state.loaded).toBe(true);
		expect(state.installedCommands.size).toBe(0);
	});
});
