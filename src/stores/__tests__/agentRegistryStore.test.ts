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
			scannedCommands: new Set(),
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

	// Callers use it to tell "not installed" from "never asked about".
	it("records which commands the scan looked up", async () => {
		mockApi.listInstalled.mockResolvedValue(["claude"]);

		await useAgentRegistryStore.getState().load(["claude", "aider"]);
		// The once-guard returns early, so this caller reads the first scan.
		await useAgentRegistryStore.getState().load(["codex"]);

		expect([...useAgentRegistryStore.getState().scannedCommands]).toEqual([
			"claude",
			"aider",
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

	// Both seeding callers read `installedCommands` the instant their promise
	// resolves. A caller that arrives mid-scan must therefore join that scan,
	// not return to the empty set it is about to replace. See ADR-0037.
	it("a caller arriving mid-scan waits for the in-flight scan", async () => {
		let release: (v: string[]) => void = () => {};
		mockApi.listInstalled.mockReturnValueOnce(
			new Promise<string[]>((resolve) => {
				release = resolve;
			}),
		);

		const first = useAgentRegistryStore.getState().load(["claude"]);
		const second = useAgentRegistryStore.getState().reload(["claude"]);
		release(["claude"]);
		await Promise.all([first, second]);

		expect(mockApi.listInstalled).toHaveBeenCalledTimes(1);
		expect([...useAgentRegistryStore.getState().installedCommands]).toEqual([
			"claude",
		]);
	});

	// Joining on the *existence* of a scan is not the same as joining on a scan
	// that answers your question. A caller asking about a command the in-flight
	// scan never looked up would otherwise be told, with no error, that it is
	// not installed. See ADR-0037.
	it("does not join an in-flight scan that omits a requested command", async () => {
		let release: (v: string[]) => void = () => {};
		mockApi.listInstalled.mockReturnValueOnce(
			new Promise<string[]>((resolve) => {
				release = resolve;
			}),
		);
		mockApi.listInstalled.mockResolvedValueOnce(["claude", "mine"]);

		const first = useAgentRegistryStore.getState().load(["claude"]);
		// "mine" was added after the first scan started, so its answer isn't in
		// there — this must wait and scan again rather than join.
		const second = useAgentRegistryStore.getState().reload(["claude", "mine"]);
		release(["claude"]);
		await Promise.all([first, second]);

		expect(mockApi.listInstalled).toHaveBeenCalledTimes(2);
		expect([...useAgentRegistryStore.getState().installedCommands]).toEqual([
			"claude",
			"mine",
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
