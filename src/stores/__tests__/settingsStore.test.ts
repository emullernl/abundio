import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/themes", () => ({
	applyTheme: vi.fn(),
	getTheme: vi.fn((name: string) => ({
		name,
		displayName: name,
		ui: {},
		terminal: { background: "#000" },
	})),
}));

import { SYSTEM_UI_FONT } from "../../lib/nerdFonts";
import { registerTerminalSettings } from "../../lib/terminalSettingsBridge";
import { applyTheme, getTheme } from "../../lib/themes";
import { useSettingsStore } from "../settingsStore";

const mockApplyTheme = vi.mocked(applyTheme);
const mockGetTheme = vi.mocked(getTheme);
// The store reaches terminals through the bridge, never by importing
// `terminalManager` — that cycle is what broke rehydration. Stand in for
// `terminalManager` by registering here. See terminalSettingsBridge.ts.
const mockSetAllTerminalsTheme = vi.fn();
const mockSetAllTerminalsFontFamily = vi.fn();
const mockSetActivityByteThreshold = vi.fn();
const mockSetWebglEnabled = vi.fn();
registerTerminalSettings({
	setAllTerminalsFontFamily: mockSetAllTerminalsFontFamily,
	setAllTerminalsFontSize: vi.fn(),
	setAllTerminalsScrollback: vi.fn(),
	setAllTerminalsTheme: mockSetAllTerminalsTheme,
	setActivityByteThreshold: mockSetActivityByteThreshold,
	setWebglEnabled: mockSetWebglEnabled,
	setMouseReportingBlocked: vi.fn(),
});

beforeEach(() => {
	vi.clearAllMocks();
	useSettingsStore.setState({
		terminalFontFamily: "'JetBrainsMonoNL Nerd Font Mono', monospace",
		uiFontFamily: SYSTEM_UI_FONT.name,
		fontSize: 14,
		uiFontSize: 14,
		theme: "default",
		rightSidebarPrRatio: 0.5,
		debugActivityMeter: false,
		activityByteThreshold: 1024,
	});
});

describe("settingsStore", () => {
	it("has correct defaults", () => {
		const state = useSettingsStore.getState();
		expect(state.terminalFontFamily).toContain("JetBrainsMonoNL");
		expect(state.uiFontFamily).toContain("system-ui");
		expect(state.fontSize).toBe(14);
		expect(state.theme).toBe("default");
		expect(state.rightSidebarPrRatio).toBe(0.5);
	});

	it("setTerminalFontFamily updates terminalFontFamily", () => {
		useSettingsStore
			.getState()
			.setTerminalFontFamily("'FiraCode Nerd Font Mono', monospace");
		expect(useSettingsStore.getState().terminalFontFamily).toBe(
			"'FiraCode Nerd Font Mono', monospace",
		);
		expect(mockSetAllTerminalsFontFamily).toHaveBeenCalledWith(
			"'FiraCode Nerd Font Mono', monospace",
		);
	});

	it("setUiFontFamily updates uiFontFamily", () => {
		useSettingsStore
			.getState()
			.setUiFontFamily("'Inter', system-ui, sans-serif");
		expect(useSettingsStore.getState().uiFontFamily).toBe(
			"'Inter', system-ui, sans-serif",
		);
	});

	it("setFontSize updates fontSize", () => {
		useSettingsStore.getState().setFontSize(18);
		expect(useSettingsStore.getState().fontSize).toBe(18);
	});

	it("setTheme calls getTheme, applyTheme, setAllTerminalsTheme", () => {
		useSettingsStore.getState().setTheme("dracula");
		expect(mockGetTheme).toHaveBeenCalledWith("dracula");
		expect(mockApplyTheme).toHaveBeenCalled();
		expect(mockSetAllTerminalsTheme).toHaveBeenCalled();
		expect(useSettingsStore.getState().theme).toBe("dracula");
	});

	it("setRightSidebarPrRatio updates ratio", () => {
		useSettingsStore.getState().setRightSidebarPrRatio(0.6);
		expect(useSettingsStore.getState().rightSidebarPrRatio).toBe(0.6);
	});

	it("toggleDebugActivityMeter flips the flag", () => {
		expect(useSettingsStore.getState().debugActivityMeter).toBe(false);
		useSettingsStore.getState().toggleDebugActivityMeter();
		expect(useSettingsStore.getState().debugActivityMeter).toBe(true);
		useSettingsStore.getState().toggleDebugActivityMeter();
		expect(useSettingsStore.getState().debugActivityMeter).toBe(false);
	});

	it("setActivityByteThreshold updates store and calls terminalManager", () => {
		useSettingsStore.getState().setActivityByteThreshold(256);
		expect(useSettingsStore.getState().activityByteThreshold).toBe(256);
		expect(mockSetActivityByteThreshold).toHaveBeenCalledWith(256);
	});

	it("gpuAccelerationEnabled defaults to true", () => {
		expect(useSettingsStore.getState().gpuAccelerationEnabled).toBe(true);
	});

	it("agentHooksEnabled defaults to true", () => {
		expect(useSettingsStore.getState().agentHooksEnabled).toBe(true);
	});

	it("setGpuAcceleration updates store and reconciles terminals", () => {
		useSettingsStore.getState().setGpuAcceleration(false);
		expect(useSettingsStore.getState().gpuAccelerationEnabled).toBe(false);
		expect(mockSetWebglEnabled).toHaveBeenCalledWith(false);

		useSettingsStore.getState().setGpuAcceleration(true);
		expect(useSettingsStore.getState().gpuAccelerationEnabled).toBe(true);
		expect(mockSetWebglEnabled).toHaveBeenCalledWith(true);
	});
});

describe("Task destination", () => {
	const migrate = () => {
		const m = useSettingsStore.persist.getOptions().migrate;
		if (!m) throw new Error("expected a migrate function");
		return m;
	};

	it("remembers every destination, New worktree included", () => {
		useSettingsStore.getState().setTaskDestination("worktree");
		expect(useSettingsStore.getState().taskDestination).toBe("worktree");
		useSettingsStore.getState().setTaskDestination("newTab");
		expect(useSettingsStore.getState().taskDestination).toBe("newTab");
	});

	it("v13 moves the old New tab default to New worktree, keeps Restart agent", () => {
		const from12 = (taskDestination: string) =>
			(migrate()({ taskDestination }, 12) as { taskDestination: string })
				.taskDestination;
		expect(from12("newTab")).toBe("worktree");
		expect(from12("restart")).toBe("restart");
		expect(
			(migrate()({}, 11) as { taskDestination: string }).taskDestination,
		).toBe("worktree");
	});
});
