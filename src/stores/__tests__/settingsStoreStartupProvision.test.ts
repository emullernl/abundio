import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the IPC surface the store touches so we can observe provisioning calls.
// NOTE: vi.resetModules() re-evaluates settingsStore but vitest caches mock
// factory results, so agentHooks is ONE shared object across imports — clear
// call history per test.
vi.mock("../../lib/ipc", () => ({
	agentHooks: {
		provision: vi.fn(() => Promise.resolve()),
		provisionStartup: vi.fn(() => Promise.resolve()),
	},
	updates: {
		setAutoCheck: vi.fn(() => Promise.resolve()),
	},
	pr: {
		setConfig: vi.fn(() => Promise.resolve()),
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

/** Import a FRESH settingsStore module — module load runs persist rehydration,
 *  which is the app-startup provisioning path (ADR-0003 Revisited). */
async function importFresh() {
	vi.resetModules();
	const ipc = await import("../../lib/ipc");
	await import("../settingsStore");
	return vi.mocked(ipc.agentHooks);
}

describe("settingsStore — startup provisioning via rehydrate", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.clearAllMocks();
	});

	it("calls provisionStartup on load when persisted agentHooksEnabled is true", async () => {
		localStorage.setItem(
			"abundio-settings",
			JSON.stringify({
				state: {
					agentHooksEnabled: true,
					agents: [
						{
							id: "claude",
							name: "claude",
							command: "claude",
							builtin: true,
							enabled: true,
						},
					],
				},
				version: 8,
			}),
		);
		const hooks = await importFresh();
		expect(hooks.provisionStartup).toHaveBeenCalledTimes(1);
		const [enabled, agentIds] = hooks.provisionStartup.mock.calls[0];
		expect(enabled).toBe(true);
		// Persisted agents are merged with the builtin roster, so the id list is
		// a superset — claude (enabled) must be in it.
		expect(agentIds).toContain("claude");
	});

	it("calls provisionStartup on a FRESH profile (no persisted settings)", async () => {
		// A brand-new install (or an empty localStorage origin) must still
		// provision — agentHooksEnabled defaults to true.
		const hooks = await importFresh();
		expect(hooks.provisionStartup).toHaveBeenCalledTimes(1);
	});

	it("does not provision when the user disabled hooks", async () => {
		localStorage.setItem(
			"abundio-settings",
			JSON.stringify({
				state: { agentHooksEnabled: false, agents: [] },
				version: 8,
			}),
		);
		const hooks = await importFresh();
		expect(hooks.provisionStartup).not.toHaveBeenCalled();
	});
});
