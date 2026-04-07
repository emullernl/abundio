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

vi.mock("../../lib/terminalManager", () => ({
	setAllTerminalsTheme: vi.fn(),
	setAllTerminalsFontFamily: vi.fn(),
	setAllTerminalsFontSize: vi.fn(),
	setActivityByteThreshold: vi.fn(),
}));

import {
	setActivityByteThreshold,
	setAllTerminalsFontFamily,
	setAllTerminalsFontSize,
	setAllTerminalsTheme,
} from "../../lib/terminalManager";
import { applyTheme, getTheme } from "../../lib/themes";
import { useSettingsStore } from "../settingsStore";

const mockApplyTheme = vi.mocked(applyTheme);
const mockGetTheme = vi.mocked(getTheme);
const mockSetAllTerminalsTheme = vi.mocked(setAllTerminalsTheme);
const mockSetAllTerminalsFontFamily = vi.mocked(setAllTerminalsFontFamily);
const mockSetAllTerminalsFontSize = vi.mocked(setAllTerminalsFontSize);
const mockSetActivityByteThreshold = vi.mocked(setActivityByteThreshold);

beforeEach(() => {
	vi.clearAllMocks();
	useSettingsStore.setState({
		terminalFontFamily: "'JetBrainsMonoNL Nerd Font Mono', monospace",
		uiFontFamily: "system-ui, -apple-system, sans-serif",
		fontSize: 14,
		uiFontSize: 14,
		theme: "default",
		sidebarCollapsed: false,
		sidebarSplitRatio: 0.4,
		debugActivityMeter: false,
		activityByteThreshold: 512,
	});
});

describe("settingsStore", () => {
	it("has correct defaults", () => {
		const state = useSettingsStore.getState();
		expect(state.terminalFontFamily).toContain("JetBrainsMonoNL");
		expect(state.uiFontFamily).toContain("system-ui");
		expect(state.fontSize).toBe(14);
		expect(state.theme).toBe("default");
		expect(state.sidebarCollapsed).toBe(false);
		expect(state.sidebarSplitRatio).toBe(0.4);
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

	it("setFontSize updates fontSize and calls setAllTerminalsFontSize", () => {
		useSettingsStore.getState().setFontSize(18);
		expect(useSettingsStore.getState().fontSize).toBe(18);
		expect(mockSetAllTerminalsFontSize).toHaveBeenCalledWith(18);
	});

	it("setTheme calls getTheme, applyTheme, setAllTerminalsTheme", () => {
		useSettingsStore.getState().setTheme("dracula");
		expect(mockGetTheme).toHaveBeenCalledWith("dracula");
		expect(mockApplyTheme).toHaveBeenCalled();
		expect(mockSetAllTerminalsTheme).toHaveBeenCalled();
		expect(useSettingsStore.getState().theme).toBe("dracula");
	});

	it("toggleSidebar flips sidebarCollapsed", () => {
		expect(useSettingsStore.getState().sidebarCollapsed).toBe(false);
		useSettingsStore.getState().toggleSidebar();
		expect(useSettingsStore.getState().sidebarCollapsed).toBe(true);
		useSettingsStore.getState().toggleSidebar();
		expect(useSettingsStore.getState().sidebarCollapsed).toBe(false);
	});

	it("setSidebarSplitRatio updates ratio", () => {
		useSettingsStore.getState().setSidebarSplitRatio(0.6);
		expect(useSettingsStore.getState().sidebarSplitRatio).toBe(0.6);
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
});
