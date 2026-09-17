/**
 * `terminalManager` imports this store, and the app's module graph enters
 * `terminalManager` first — so `persist` hydrates this store *during*
 * `terminalManager`'s import phase, before a line of its body has run and while
 * every one of its top-level bindings is still in the temporal dead zone.
 *
 * Calling its setters from `onRehydrateStorage` therefore threw, zustand
 * swallowed the throw, and the whole handler was skipped: "Block mouse
 * reporting: off" kept blocking, because the master switch never left its
 * default of ON. These tests reproduce that exact import order and pin the
 * bridge that fixes it.
 */
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/ipc", () => ({
	pty: {},
	agentHooks: { provisionStartup: vi.fn().mockResolvedValue(undefined) },
	updates: { setAutoCheck: vi.fn().mockResolvedValue(undefined) },
	pr: { setConfig: vi.fn().mockResolvedValue(undefined) },
	listen: vi.fn().mockResolvedValue(() => {}),
	invoke: vi.fn(),
}));

beforeEach(() => {
	vi.resetModules();
});

it("applies every rehydrated setting when terminalManager is imported first", async () => {
	localStorage.setItem(
		"abundio-settings",
		JSON.stringify({
			state: { blockMouseReporting: false, prPollEnabled: false },
			version: 9,
		}),
	);
	// The app's real evaluation order: terminalManager enters the cycle first.
	await import("../../lib/terminalManager");
	await import("../settingsStore");

	const { updates, pr } = await import("../../lib/ipc");
	// These sit at the END of the handler, so they only fire if nothing above
	// them threw.
	expect(updates.setAutoCheck).toHaveBeenCalled();
	expect(pr.setConfig).toHaveBeenCalledWith(false, 5);
});

it("hands a stored mouse-reporting answer of false to terminalManager", async () => {
	localStorage.setItem(
		"abundio-settings",
		JSON.stringify({ state: { blockMouseReporting: false }, version: 9 }),
	);
	const bridge = await import("../../lib/terminalSettingsBridge");
	const calls: boolean[] = [];
	// Stand in for terminalManager, registering BEFORE the store hydrates so we
	// see the push as a live pane would.
	bridge.registerTerminalSettings({
		setAllTerminalsFontFamily: () => {},
		setAllTerminalsFontSize: () => {},
		setAllTerminalsScrollback: () => {},
		setAllTerminalsTheme: () => {},
		setActivityByteThreshold: () => {},
		setWebglEnabled: () => {},
		setMouseReportingBlocked: (blocked) => calls.push(blocked),
	});
	await import("../settingsStore");

	expect(calls).toEqual([false]);
});

it("pushes GPU acceleration in both directions, not only when disabled", async () => {
	// `gpuAccelerationEnabled` crosses Window boundaries (it is not in
	// NOT_BROADCAST), and the receiving side's only reaction is a rehydrate. A
	// push that fired only on `false` would leave the other Window on the DOM
	// renderer for the rest of the session after the user re-enabled it here.
	localStorage.setItem(
		"abundio-settings",
		JSON.stringify({ state: { gpuAccelerationEnabled: true }, version: 9 }),
	);
	const bridge = await import("../../lib/terminalSettingsBridge");
	const calls: boolean[] = [];
	bridge.registerTerminalSettings({
		setAllTerminalsFontFamily: () => {},
		setAllTerminalsFontSize: () => {},
		setAllTerminalsScrollback: () => {},
		setAllTerminalsTheme: () => {},
		setActivityByteThreshold: () => {},
		setWebglEnabled: (enabled) => calls.push(enabled),
		setMouseReportingBlocked: () => {},
	});
	await import("../settingsStore");

	expect(calls).toEqual([true]);
});

it("queues pushes made before terminalManager registers, in order", async () => {
	const bridge = await import("../../lib/terminalSettingsBridge");
	bridge.resetTerminalSettingsForTest();
	const seen: string[] = [];
	bridge.withTerminalSettings((t) => t.setAllTerminalsFontSize(12));
	bridge.withTerminalSettings((t) => t.setMouseReportingBlocked(false));
	expect(seen).toEqual([]);

	bridge.registerTerminalSettings({
		setAllTerminalsFontFamily: () => {},
		setAllTerminalsFontSize: (n) => seen.push(`size:${n}`),
		setAllTerminalsScrollback: () => {},
		setAllTerminalsTheme: () => {},
		setActivityByteThreshold: () => {},
		setWebglEnabled: () => {},
		setMouseReportingBlocked: (b) => seen.push(`mouse:${b}`),
	});
	expect(seen).toEqual(["size:12", "mouse:false"]);

	// Registered now, so a later push runs straight through.
	bridge.withTerminalSettings((t) => t.setMouseReportingBlocked(true));
	expect(seen).toEqual(["size:12", "mouse:false", "mouse:true"]);
});
